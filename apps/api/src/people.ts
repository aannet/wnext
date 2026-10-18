import type { PersonCreate, PersonPatch, PersonProject } from "@wnext/contracts";
import { withContext, type Db, type Queryable, type RequestContext } from "./db";
import { ApiFailure } from "./failure";
import { DEFAULT_PAGE, MAX_PAGE, decodeCursor, encodeCursor, reader } from "./reference";
import { PROJECT_COLUMNS, PERSON_COLUMNS, toSchedulePerson, toScheduleProject, type Row, type SchedulePerson } from "./schedule";
import { assertWriter, idParam, isId, lockAndCheck, notFound } from "./write";

// Écriture des personnes planifiables. Mêmes principes que les allocations et les congés (rôles, verrou optimiste, RLS +
// account_id). Pas de suppression (voir le contrat) : `active: false` désactive sans toucher aux allocations ni aux congés.
// Ni e-mail ni coût : ces colonnes ne sont ni lues ni écrites ici.

const DEFAULT_WORK_DAYS = [8, 8, 8, 8, 8, 0, 0];

async function assertReferences(tx: Queryable, accountId: string, ref: { departmentId?: string | null; roleId?: string | null }) {
  const exists = async (sql: string, id: string, entity: string) => {
    if (!isId(id) || !(await tx.query(sql, [id, accountId])).rows.length) throw notFound(entity);
  };
  if (ref.departmentId) await exists("SELECT 1 FROM departments WHERE id = $1::bigint AND account_id = $2::bigint", ref.departmentId, "department");
  if (ref.roleId) await exists("SELECT 1 FROM roles WHERE id = $1::bigint AND account_id = $2::bigint", ref.roleId, "role");
}

export async function createPerson(db: Db, ctx: RequestContext, body: PersonCreate): Promise<SchedulePerson> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    await assertReferences(tx, ctx.accountId, body);
    const { rows } = await tx.query<Row>(
      `INSERT INTO people (account_id, name, people_type, department_id, role_id, country, work_days_hours, tags, avatar_url, active)
       VALUES ($1::bigint, $2, $3::people_type, $4::bigint, $5::bigint, $6, $7::numeric[], $8::text[], $9, $10::boolean)
       RETURNING ${PERSON_COLUMNS}`,
      [
        ctx.accountId, body.name, body.peopleType ?? "employee", body.departmentId ?? null, body.roleId ?? null, body.country ?? null,
        body.workDaysHours ?? DEFAULT_WORK_DAYS, body.tags ?? [], body.avatarUrl ?? null, body.active ?? true,
      ],
    );
    return toSchedulePerson(rows[0]!);
  });
}

export async function updatePerson(db: Db, ctx: RequestContext, id: string, expectedVersion: number, patch: PersonPatch): Promise<SchedulePerson> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    const cur = await lockAndCheck(tx, "people", PERSON_COLUMNS, "person", ctx.accountId, id, expectedVersion);
    const has = <K extends keyof PersonPatch>(k: K) => patch[k] !== undefined;
    const idOrNull = (v: unknown) => (v === null ? null : String(v));

    const departmentId = has("departmentId") ? patch.departmentId! : idOrNull(cur.department_id);
    const roleId = has("roleId") ? patch.roleId! : idOrNull(cur.role_id);
    // Seules les références CHANGÉES sont revérifiées : une personne dont le département a disparu reste modifiable.
    await assertReferences(tx, ctx.accountId, { departmentId: has("departmentId") ? departmentId : null, roleId: has("roleId") ? roleId : null });

    const { rows } = await tx.query<Row>(
      `UPDATE people SET name = $3, people_type = $4::people_type, department_id = $5::bigint, role_id = $6::bigint, country = $7,
              work_days_hours = $8::numeric[], tags = $9::text[], avatar_url = $10, active = $11::boolean
        WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $12::int
        RETURNING ${PERSON_COLUMNS}`,
      [
        id, ctx.accountId, patch.name ?? cur.name, patch.peopleType ?? cur.people_type, departmentId, roleId,
        has("country") ? patch.country : cur.country === null ? null : String(cur.country).trim(),
        patch.workDaysHours ?? (cur.work_days_hours as unknown[]).map(Number), patch.tags ?? cur.tags,
        has("avatarUrl") ? patch.avatarUrl : cur.avatar_url, patch.active ?? cur.active, expectedVersion,
      ],
    );
    if (!rows[0]) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(cur.row_version) + 1 });
    return toSchedulePerson(rows[0]);
  });
}

// --- Lecture ----------------------------------------------------------------------------------------------------------
// Tout membre authentifié lit (mêmes champs que GET /schedule : ni coût ni e-mail). La RLS et `account_id` isolent les comptes.

/** Sous-chaîne littérale pour ILIKE : % _ et \ perdent leur sens de joker. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export const personReader = reader({
  table: "people", columns: PERSON_COLUMNS, entity: "person", map: toSchedulePerson,
  filters: (q, bind) => [
    ...(q.includeInactive ? [] : ["active"]), // comme le Schedule : les désactivées sur demande
    ...(q.departmentId ? [`department_id = ${bind(idParam("departmentId", q.departmentId))}::bigint`] : []),
    ...(q.roleId ? [`role_id = ${bind(idParam("roleId", q.roleId))}::bigint`] : []),
    ...(q.tag ? [`${bind(q.tag)}::text = ANY (tags)`] : []),
    ...(q.search ? [`name ILIKE '%' || ${bind(likeEscape(q.search))} || '%' ESCAPE '\\'`] : []),
  ],
});

// `getPerson` ne filtre PAS sur `active` : une personne désactivée se lit par son id (réactivation, historique). Le reader de liste
// ajoute le filtre, la lecture par id non.

/**
 * Projets d'une personne : ceux où elle est dans l'équipe OU qui ont au moins une allocation d'elle (l'équipe n'est pas exigée pour
 * allouer, Q-07). Page par curseur sur l'identifiant du projet ; archivés exclus sauf `status=archived`.
 */
export async function listPersonProjects(db: Db, ctx: RequestContext, personId: string, q: { limit?: number; cursor?: string; status?: string }): Promise<{ items: PersonProject[]; page: { nextCursor: string | null; total: number } }> {
  const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor); // avant d'ouvrir une transaction
  const n = Math.min(Math.max(1, Math.trunc(q.limit ?? DEFAULT_PAGE)), MAX_PAGE);
  if (!isId(personId)) throw notFound("person");
  return withContext(db, ctx, async (tx) => {
    if (!(await tx.query("SELECT 1 FROM people WHERE id = $1::bigint AND account_id = $2::bigint", [personId, ctx.accountId])).rows.length) throw notFound("person");
    const args: unknown[] = [ctx.accountId, personId];
    const bind = (v: unknown) => { args.push(v); return `$${args.length}`; };
    const where = [
      "pr.account_id = $1::bigint",
      q.status ? `pr.status = ${bind(q.status)}::project_status` : "pr.status <> 'archived'",
      `(EXISTS (SELECT 1 FROM project_team t WHERE t.account_id = $1::bigint AND t.project_id = pr.id AND t.person_id = $2::bigint)
        OR EXISTS (SELECT 1 FROM allocations a WHERE a.account_id = $1::bigint AND a.project_id = pr.id AND a.person_id = $2::bigint))`,
    ];
    const total = Number((await tx.query<Row>(`SELECT count(*) AS n FROM projects pr WHERE ${where.join(" AND ")}`, [...args])).rows[0]!.n);
    if (after !== undefined) where.push(`pr.id > ${bind(after)}::bigint`);
    const { rows } = await tx.query<Row>(
      `SELECT ${PROJECT_COLUMNS.split(", ").map((c) => `pr.${c}`).join(", ")},
              EXISTS (SELECT 1 FROM project_team t WHERE t.account_id = $1::bigint AND t.project_id = pr.id AND t.person_id = $2::bigint) AS in_team,
              (SELECT count(*) FROM allocations a WHERE a.account_id = $1::bigint AND a.project_id = pr.id AND a.person_id = $2::bigint) AS allocation_count
         FROM projects pr WHERE ${where.join(" AND ")} ORDER BY pr.id LIMIT ${bind(n + 1)}::int`,
      args,
    );
    const page = rows.slice(0, n);
    return {
      items: page.map((r) => ({ project: toScheduleProject(r), inTeam: Boolean(r.in_team), allocationCount: Number(r.allocation_count) })),
      page: { nextCursor: rows.length > n ? encodeCursor(String(page[n - 1]!.id)) : null, total },
    };
  });
}
