// GENERE par packages/contracts-tools (npm run generate:contract) a partir de
// packages/contracts/openapi.json. Ne pas editer a la main.

export interface ApiError {
  code: ErrorCode;
  params: {
    [key: string]: string | number | boolean;
  };
  requestId: string;
}

export type ErrorCode = "INTERNAL_ERROR" | "VALIDATION_FAILED" | "UNAUTHENTICATED" | "SCHEDULE_RANGE_INVALID" | "SCHEDULE_CURSOR_INVALID" | "FORBIDDEN" | "NOT_FOUND" | "VERSION_CONFLICT" | "PRECONDITION_REQUIRED";

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
  name: string;
  date: IsoDate;
  country: string | null;
  departmentId: Id | null;
  hoursOff: number | null;
}

export interface ScheduleProject {
  id: Id;
  name: string;
  projectCode: string | null;
  color: string;
  status: "tentative" | "planned" | "in_progress" | "on_hold" | "completed" | "archived";
  nonBillable: boolean;
}

export interface ScheduleTimeoffType {
  id: Id;
  name: string;
  deducted: boolean;
}

export interface ScheduleDepartment {
  id: Id;
  name: string;
}

export interface ScheduleRole {
  id: Id;
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
  };
}
