// GENERE par packages/contracts-tools (npm run generate:contract) a partir de
// packages/contracts/openapi.json. Ne pas editer a la main.

export interface ApiError {
  code: ErrorCode;
  params: {
    [key: string]: string | number | boolean;
  };
  requestId: string;
}

export type ErrorCode = "INTERNAL_ERROR" | "VALIDATION_FAILED" | "UNAUTHENTICATED" | "SCHEDULE_RANGE_INVALID" | "SCHEDULE_CURSOR_INVALID" | "FORBIDDEN" | "NOT_FOUND" | "VERSION_CONFLICT" | "PRECONDITION_REQUIRED" | "TIMEOFF_OVERLAP" | "ALREADY_EXISTS" | "REFERENCE_IN_USE" | "TEAM_REMOVAL_CONFIRMATION_REQUIRED" | "TEAM_REMOVAL_STALE_CONFIRMATION" | "TEAM_REMOVAL_LOCKED_LOGS";

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
}

export interface ScheduleResponse {
  window: {
    from: IsoDate;
    to: IsoDate;
  };
  changeCursor: string;
  page: SchedulePage;
  account: ScheduleAccount;
  people: Array<SchedulePerson>;
  allocations: Array<ScheduleAllocation>;
  timeoffs: Array<ScheduleTimeoff>;
  holidays: Array<ScheduleHoliday>;
  projects: Array<ScheduleProject>;
  timeoffTypes: Array<ScheduleTimeoffType>;
  departments: Array<ScheduleDepartment>;
  roles: Array<ScheduleRole>;
}

export type IsoDate = string;

export interface SchedulePage {
  nextCursor: string | null;
  total: number;
}

export interface ScheduleAccount {
  weekStart: number;
  capacityThresholds: {
    underPercent: number;
  };
}

export interface SchedulePerson {
  id: Id;
  version: Version;
  name: string;
  peopleType: SchedulePeopleType;
  departmentId: Id | null;
  roleId: Id | null;
  country: string | null;
  workDaysHours: Array<number>;
  tags: Array<string>;
  avatarUrl: string | null;
  active: boolean;
}

export type Id = string;

export type Version = number;

export type SchedulePeopleType = "employee" | "contractor" | "placeholder";

export type ScheduleAllocation = {
  id: Id;
  version: Version;
  personId: Id;
  projectId: Id;
  phaseId: Id | null;
  taskId: Id | null;
  groupId: Id | null;
  name: string | null;
  notes: string | null;
  startDate: IsoDate;
  endDate: IsoDate;
  status: "tentative" | "confirmed";
  billable: boolean;
  priority: number;
  repeatState: "none" | "daily" | "weekly" | "monthly";
  repeatEndDate: IsoDate | null;
  mode: "hours";
  hoursPerDay: number;
  percent: null;
} | {
  id: Id;
  version: Version;
  personId: Id;
  projectId: Id;
  phaseId: Id | null;
  taskId: Id | null;
  groupId: Id | null;
  name: string | null;
  notes: string | null;
  startDate: IsoDate;
  endDate: IsoDate;
  status: "tentative" | "confirmed";
  billable: boolean;
  priority: number;
  repeatState: "none" | "daily" | "weekly" | "monthly";
  repeatEndDate: IsoDate | null;
  mode: "percentage";
  hoursPerDay: null;
  percent: number;
};

export interface ScheduleTimeoff {
  id: Id;
  version: Version;
  personId: Id;
  typeId: Id;
  startDate: IsoDate;
  endDate: IsoDate;
  scope: "full_day" | "partial";
  startHalf: "am" | "pm";
  endHalf: "am" | "pm";
  hoursPerDay: number | null;
  approvalStatus: "pending" | "approved" | "declined";
}

export interface ScheduleHoliday {
  id: Id;
  version: Version;
  name: string;
  date: IsoDate;
  country: string | null;
  departmentId: Id | null;
  hoursOff: number | null;
}

export interface ScheduleProject {
  id: Id;
  version: Version;
  name: string;
  projectCode: string | null;
  color: string;
  status: "tentative" | "planned" | "in_progress" | "on_hold" | "completed" | "archived";
  nonBillable: boolean;
}

export interface ScheduleTimeoffType {
  id: Id;
  version: Version;
  name: string;
  deducted: boolean;
}

export interface ScheduleDepartment {
  id: Id;
  version: Version;
  name: string;
}

export interface ScheduleRole {
  id: Id;
  version: Version;
  name: string;
}

export interface AllocationCreate {
  personId: Id;
  projectId: Id;
  phaseId?: Id | null;
  taskId?: Id | null;
  name?: string | null;
  notes?: string | null;
  startDate: IsoDate;
  endDate: IsoDate;
  status?: "tentative" | "confirmed";
  billable?: boolean;
  priority?: number;
  repeatState?: "none" | "daily" | "weekly" | "monthly";
  repeatEndDate?: IsoDate | null;
  load: AllocationLoad;
}

export type AllocationLoad = {
  mode: "hours";
  hoursPerDay: number;
} | {
  mode: "percentage";
  percent: number;
};

export interface AllocationPatch {
  personId?: Id;
  projectId?: Id;
  phaseId?: Id | null;
  taskId?: Id | null;
  name?: string | null;
  notes?: string | null;
  startDate?: IsoDate;
  endDate?: IsoDate;
  status?: "tentative" | "confirmed";
  billable?: boolean;
  priority?: number;
  repeatState?: "none" | "daily" | "weekly" | "monthly";
  repeatEndDate?: IsoDate | null;
  load?: AllocationLoad;
}

export interface TimeoffCreate {
  personId: Id;
  typeId: Id;
  startDate: IsoDate;
  endDate: IsoDate;
  scope?: "full_day" | "partial";
  startHalf?: "am" | "pm";
  endHalf?: "am" | "pm";
  hoursPerDay?: number | null;
  approvalStatus?: "pending" | "approved" | "declined";
  notes?: string | null;
}

export interface TimeoffPatch {
  personId?: Id;
  typeId?: Id;
  startDate?: IsoDate;
  endDate?: IsoDate;
  scope?: "full_day" | "partial";
  startHalf?: "am" | "pm";
  endHalf?: "am" | "pm";
  hoursPerDay?: number | null;
  approvalStatus?: "pending" | "approved" | "declined";
  notes?: string | null;
}

export interface PersonCreate {
  name: string;
  peopleType?: SchedulePeopleType;
  departmentId?: Id | null;
  roleId?: Id | null;
  country?: string | null;
  workDaysHours?: Array<number>;
  tags?: Array<string>;
  avatarUrl?: string | null;
  active?: boolean;
}

export interface PersonPatch {
  name?: string;
  peopleType?: SchedulePeopleType;
  departmentId?: Id | null;
  roleId?: Id | null;
  country?: string | null;
  workDaysHours?: Array<number>;
  tags?: Array<string>;
  avatarUrl?: string | null;
  active?: boolean;
}

export interface TeamRemovalSummary {
  inTeam: boolean;
  allocationCount: number;
  firstAllocation: IsoDate | null;
  lastAllocation: IsoDate | null;
  logCount: number;
  logHours: number;
  lockedLogCount: number;
  canRemove: boolean;
}

export interface TeamRemovalResult {
  removedAllocations: number;
  removedLogs: number;
  removedLogHours: number;
  wasInTeam: boolean;
}

export interface TeamRemovalRequest {
  confirmation?: {
    allocationCount: number;
    logCount: number;
    logHours: number;
  };
}

export interface TeamMembership {
  added: boolean;
}

export interface DepartmentCreate {
  name: string;
}

export interface DepartmentPatch {
  name?: string;
}

export interface RoleCreate {
  name: string;
}

export interface RolePatch {
  name?: string;
}

export interface TimeoffTypeCreate {
  name: string;
  deducted?: boolean;
}

export interface TimeoffTypePatch {
  name?: string;
  deducted?: boolean;
}

export interface HolidayCreate {
  name: string;
  date: IsoDate;
  country?: string | null;
  departmentId?: Id | null;
  hoursOff?: number | null;
}

export interface HolidayPatch {
  name?: string;
  date?: IsoDate;
  country?: string | null;
  departmentId?: Id | null;
  hoursOff?: number | null;
}

export interface ProjectDetail {
  id: Id;
  version: Version;
  name: string;
  projectCode: string | null;
  color: string;
  status: "tentative" | "planned" | "in_progress" | "on_hold" | "completed" | "archived";
  nonBillable: boolean;
  startDate: IsoDate | null;
  endDate: IsoDate | null;
  projectManagerId: Id | null;
  tags: Array<string>;
  notes: string | null;
}

export interface ProjectCreate {
  name: string;
  projectCode?: string | null;
  color?: string;
  startDate?: IsoDate | null;
  endDate?: IsoDate | null;
  status?: "tentative" | "planned" | "in_progress" | "on_hold" | "completed" | "archived";
  projectManagerId?: Id | null;
  nonBillable?: boolean;
  tags?: Array<string>;
  notes?: string | null;
}

export interface ProjectPatch {
  name?: string;
  projectCode?: string | null;
  color?: string;
  startDate?: IsoDate | null;
  endDate?: IsoDate | null;
  status?: "tentative" | "planned" | "in_progress" | "on_hold" | "completed" | "archived";
  projectManagerId?: Id | null;
  nonBillable?: boolean;
  tags?: Array<string>;
  notes?: string | null;
}

export interface FetchResponse {
  status: number;
  json(): Promise<unknown>;
}
export type Fetcher = (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => Promise<FetchResponse>;

export type ApiResult<T, E> = { ok: true; status: number; data: T } | { ok: false; status: number; error: E };

/** Valeurs indefinies omises ; un tableau repete la cle (?tag=a&tag=b). */
function toQueryString(query: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export function createClient(options: { baseUrl: string; fetch: Fetcher }) {
  return {
    /** Etat du service (GET /api/v1/health) */
    async getHealth(): Promise<ApiResult<HealthResponse, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/health", { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as HealthResponse }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Fenetre du Schedule (personnes, allocations, conges, feries, projets) (GET /api/v1/schedule) */
    async getSchedule(query: {
      from: string;
      to: string;
      departmentId?: string;
      roleId?: string;
      projectId?: string;
      tag?: string;
      includeInactive?: boolean;
      limit?: number;
      cursor?: string;
    }): Promise<ApiResult<ScheduleResponse, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/schedule" + toQueryString(query), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ScheduleResponse }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Creer une allocation (la sur-allocation n'est jamais refusee, BR-01) (POST /api/v1/allocations) */
    async createAllocation(input: {
      body: AllocationCreate;
    }): Promise<ApiResult<ScheduleAllocation, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/allocations", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ScheduleAllocation }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Modifier ou deplacer une allocation (verrou optimiste If-Match) (PATCH /api/v1/allocations/{id}) */
    async updateAllocation(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
      body: AllocationPatch;
    }): Promise<ApiResult<ScheduleAllocation, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/allocations/" + encodeURIComponent(String(input.path.id)), { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", ...input.headers }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ScheduleAllocation }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Supprimer une allocation (verrou optimiste If-Match) (DELETE /api/v1/allocations/{id}) */
    async deleteAllocation(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
    }): Promise<ApiResult<void, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/allocations/" + encodeURIComponent(String(input.path.id)), { method: "DELETE", headers: { accept: "application/json", ...input.headers } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as void }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Creer un conge (jamais refuse pour cause d'allocations existantes, BR-04) (POST /api/v1/timeoffs) */
    async createTimeoff(input: {
      body: TimeoffCreate;
    }): Promise<ApiResult<ScheduleTimeoff, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/timeoffs", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ScheduleTimeoff }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Modifier un conge (verrou optimiste If-Match) (PATCH /api/v1/timeoffs/{id}) */
    async updateTimeoff(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
      body: TimeoffPatch;
    }): Promise<ApiResult<ScheduleTimeoff, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/timeoffs/" + encodeURIComponent(String(input.path.id)), { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", ...input.headers }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ScheduleTimeoff }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Supprimer un conge (verrou optimiste If-Match) (DELETE /api/v1/timeoffs/{id}) */
    async deleteTimeoff(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
    }): Promise<ApiResult<void, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/timeoffs/" + encodeURIComponent(String(input.path.id)), { method: "DELETE", headers: { accept: "application/json", ...input.headers } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as void }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Creer une personne planifiable (POST /api/v1/people) */
    async createPerson(input: {
      body: PersonCreate;
    }): Promise<ApiResult<SchedulePerson, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/people", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as SchedulePerson }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Modifier ou desactiver une personne (verrou optimiste If-Match ; pas de suppression) (PATCH /api/v1/people/{id}) */
    async updatePerson(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
      body: PersonPatch;
    }): Promise<ApiResult<SchedulePerson, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/people/" + encodeURIComponent(String(input.path.id)), { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", ...input.headers }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as SchedulePerson }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Recapitulatif du retrait d'une personne d'un projet (BR-10) : ce qui serait supprime, sans rien ecrire (GET /api/v1/projects/{projectId}/team/{personId}/removal-summary) */
    async getTeamRemovalSummary(input: {
      path: {
        projectId: Id;
        personId: Id;
      };
    }): Promise<ApiResult<TeamRemovalSummary, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/projects/" + encodeURIComponent(String(input.path.projectId)) + "/team/" + encodeURIComponent(String(input.path.personId)) + "/removal-summary", { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as TeamRemovalSummary }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Retirer une personne d'un projet : supprime ses allocations et ses temps saisis sur ce projet, apres confirmation (BR-10) (POST /api/v1/projects/{projectId}/team/{personId}/removal) */
    async removeFromTeam(input: {
      path: {
        projectId: Id;
        personId: Id;
      };
      body: TeamRemovalRequest;
    }): Promise<ApiResult<TeamRemovalResult, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/projects/" + encodeURIComponent(String(input.path.projectId)) + "/team/" + encodeURIComponent(String(input.path.personId)) + "/removal", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as TeamRemovalResult }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Ajouter une personne a l'equipe d'un projet (idempotent, sans corps) (PUT /api/v1/projects/{projectId}/team/{personId}) */
    async addToTeam(input: {
      path: {
        projectId: Id;
        personId: Id;
      };
    }): Promise<ApiResult<TeamMembership, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/projects/" + encodeURIComponent(String(input.path.projectId)) + "/team/" + encodeURIComponent(String(input.path.personId)), { method: "PUT", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as TeamMembership }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Creer : departement (POST /api/v1/departments) */
    async createDepartment(input: {
      body: DepartmentCreate;
    }): Promise<ApiResult<ScheduleDepartment, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/departments", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ScheduleDepartment }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Modifier : departement (verrou optimiste If-Match) (PATCH /api/v1/departments/{id}) */
    async updateDepartment(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
      body: DepartmentPatch;
    }): Promise<ApiResult<ScheduleDepartment, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/departments/" + encodeURIComponent(String(input.path.id)), { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", ...input.headers }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ScheduleDepartment }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Supprimer : departement (verrou optimiste If-Match ; refuse si reference) (DELETE /api/v1/departments/{id}) */
    async deleteDepartment(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
    }): Promise<ApiResult<void, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/departments/" + encodeURIComponent(String(input.path.id)), { method: "DELETE", headers: { accept: "application/json", ...input.headers } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as void }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Creer : role (POST /api/v1/roles) */
    async createRole(input: {
      body: RoleCreate;
    }): Promise<ApiResult<ScheduleRole, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/roles", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ScheduleRole }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Modifier : role (verrou optimiste If-Match) (PATCH /api/v1/roles/{id}) */
    async updateRole(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
      body: RolePatch;
    }): Promise<ApiResult<ScheduleRole, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/roles/" + encodeURIComponent(String(input.path.id)), { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", ...input.headers }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ScheduleRole }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Supprimer : role (verrou optimiste If-Match ; refuse si reference) (DELETE /api/v1/roles/{id}) */
    async deleteRole(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
    }): Promise<ApiResult<void, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/roles/" + encodeURIComponent(String(input.path.id)), { method: "DELETE", headers: { accept: "application/json", ...input.headers } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as void }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Creer : type de conge (POST /api/v1/timeoff-types) */
    async createTimeoffType(input: {
      body: TimeoffTypeCreate;
    }): Promise<ApiResult<ScheduleTimeoffType, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/timeoff-types", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ScheduleTimeoffType }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Modifier : type de conge (verrou optimiste If-Match) (PATCH /api/v1/timeoff-types/{id}) */
    async updateTimeoffType(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
      body: TimeoffTypePatch;
    }): Promise<ApiResult<ScheduleTimeoffType, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/timeoff-types/" + encodeURIComponent(String(input.path.id)), { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", ...input.headers }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ScheduleTimeoffType }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Supprimer : type de conge (verrou optimiste If-Match ; refuse si reference) (DELETE /api/v1/timeoff-types/{id}) */
    async deleteTimeoffType(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
    }): Promise<ApiResult<void, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/timeoff-types/" + encodeURIComponent(String(input.path.id)), { method: "DELETE", headers: { accept: "application/json", ...input.headers } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as void }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Creer : jour ferie (POST /api/v1/holidays) */
    async createHoliday(input: {
      body: HolidayCreate;
    }): Promise<ApiResult<ScheduleHoliday, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/holidays", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ScheduleHoliday }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Modifier : jour ferie (verrou optimiste If-Match) (PATCH /api/v1/holidays/{id}) */
    async updateHoliday(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
      body: HolidayPatch;
    }): Promise<ApiResult<ScheduleHoliday, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/holidays/" + encodeURIComponent(String(input.path.id)), { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", ...input.headers }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ScheduleHoliday }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Supprimer : jour ferie (verrou optimiste If-Match ; refuse si reference) (DELETE /api/v1/holidays/{id}) */
    async deleteHoliday(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
    }): Promise<ApiResult<void, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/holidays/" + encodeURIComponent(String(input.path.id)), { method: "DELETE", headers: { accept: "application/json", ...input.headers } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as void }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Creer : projet (POST /api/v1/projects) */
    async createProject(input: {
      body: ProjectCreate;
    }): Promise<ApiResult<ProjectDetail, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/projects", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ProjectDetail }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Modifier : projet (verrou optimiste If-Match) (PATCH /api/v1/projects/{id}) */
    async updateProject(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
      body: ProjectPatch;
    }): Promise<ApiResult<ProjectDetail, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/projects/" + encodeURIComponent(String(input.path.id)), { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", ...input.headers }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ProjectDetail }
        : { ok: false, status: res.status, error: body as ApiError };
    },
  };
}
