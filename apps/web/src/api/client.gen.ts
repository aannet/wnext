// GENERE par packages/contracts-tools (npm run generate:contract) a partir de
// packages/contracts/openapi.json. Ne pas editer a la main.

export interface ApiError {
  code: ErrorCode;
  params: {
    [key: string]: string | number | boolean;
  };
  requestId: string;
}

export type ErrorCode = "INTERNAL_ERROR" | "VALIDATION_FAILED" | "UNAUTHENTICATED" | "SCHEDULE_RANGE_INVALID" | "SCHEDULE_CURSOR_INVALID" | "FORBIDDEN" | "NOT_FOUND" | "VERSION_CONFLICT" | "PRECONDITION_REQUIRED" | "TIMEOFF_OVERLAP" | "ALREADY_EXISTS" | "REFERENCE_IN_USE" | "TEAM_REMOVAL_CONFIRMATION_REQUIRED" | "TEAM_REMOVAL_STALE_CONFIRMATION" | "TEAM_REMOVAL_LOCKED_LOGS" | "PERSON_DEACTIVATION_CONFIRMATION_REQUIRED" | "PERSON_DEACTIVATION_STALE_CONFIRMATION" | "PERSON_DEACTIVATION_INVALID_REPLACEMENT" | "LOGGED_TIME_LOCKED" | "LOGGED_TIME_DAY_LIMIT" | "RATE_LIMITED" | "NOT_A_SERIES" | "OCCURRENCE_NOT_FOUND" | "SERIES_SPLIT_UNSUPPORTED" | "PERSON_HISTORY_LOCKED";

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
}

export interface RealtimeTicket {
  ticket: string;
  expiresInSeconds: number;
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
  timezone: string;
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
  startDate: IsoDate | null;
  endDate: IsoDate | null;
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

export interface ProjectAllocationList {
  items: Array<ScheduleAllocation>;
  page: SchedulePage;
}

export interface AllocationGroup {
  groupId: Id;
  items: Array<ScheduleAllocation>;
}

export interface AllocationGroupCreate {
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
  load?: {
    mode: "hours";
    hoursPerDay: number;
  } | {
    mode: "percentage";
    percent: number;
  };
  members: Array<{
    personId: Id;
    load?: {
      mode: "hours";
      hoursPerDay: number;
    } | {
      mode: "percentage";
      percent: number;
    };
  }>;
}

export interface AllocationGroupPatch {
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

export interface AllocationSplitResult {
  before?: ScheduleAllocation;
  occurrence?: ScheduleAllocation;
  after?: ScheduleAllocation;
}

export interface AllocationSplit {
  occurrenceDate: IsoDate;
  patch?: {
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
    load?: AllocationLoad;
  };
  delete?: true;
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

export interface LoggedTimeList {
  items: Array<LoggedTime>;
}

export interface LoggedTime {
  id: Id;
  version: Version;
  personId: Id;
  projectId: Id;
  phaseId: Id | null;
  taskId: Id | null;
  allocationId: Id | null;
  workDate: IsoDate;
  hours: number;
  billable: boolean;
  notes: string | null;
  status: LoggedTimeStatus;
}

export type LoggedTimeStatus = "draft" | "submitted" | "approved" | "locked";

export interface LoggedTimeCreate {
  personId: Id;
  projectId: Id;
  workDate: IsoDate;
  phaseId?: Id | null;
  taskId?: Id | null;
  hours: number;
  billable?: boolean;
  notes?: string | null;
}

export interface LoggedTimePatch {
  phaseId?: Id | null;
  taskId?: Id | null;
  hours?: number;
  billable?: boolean;
  notes?: string | null;
}

export interface LoggedTimePrefillResult {
  items: Array<LoggedTime>;
  createdCount: number;
}

export interface LoggedTimeWindow {
  personId: Id;
  from: IsoDate;
  to: IsoDate;
}

export interface LoggedTimeSubmitResult {
  items: Array<LoggedTime>;
  submittedCount: number;
}

export interface PersonList {
  items: Array<SchedulePerson>;
  page: SchedulePage;
}

export interface PersonProjectList {
  items: Array<PersonProject>;
  page: SchedulePage;
}

export interface PersonProject {
  project: ScheduleProject;
  inTeam: boolean;
  allocationCount: number;
}

export interface PersonHistoryList {
  items: Array<PersonHistoryEntry>;
  page: SchedulePage;
}

export type PersonHistoryEntry = {
  id: Id;
  validFrom: IsoDate | null;
  validTo: IsoDate | null;
  attribute: "workDaysHours";
  workDaysHours: Array<number>;
} | {
  id: Id;
  validFrom: IsoDate | null;
  validTo: IsoDate | null;
  attribute: "departmentId";
  departmentId: Id | null;
} | {
  id: Id;
  validFrom: IsoDate | null;
  validTo: IsoDate | null;
  attribute: "roleId";
  roleId: Id | null;
};

export interface PersonDeactivationSummary {
  alreadyInactive: boolean;
  asOf: IsoDate;
  allocationCount: number;
  projectCount: number;
  firstAllocation: IsoDate | null;
  lastAllocation: IsoDate | null;
}

export interface PersonDeactivationResult {
  person: {
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
  };
  reassignedAllocations: number;
  deletedAllocations: number;
}

export interface PersonDeactivationRequest {
  asOf?: string;
  disposition?: "reassign" | "delete";
  replacementId?: string;
  confirmation?: {
    allocationCount: number;
  };
}

export interface PersonAllocationList {
  items: Array<ScheduleAllocation>;
  page: SchedulePage;
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
  effectiveFrom?: string;
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

export interface TeamMemberList {
  items: Array<TeamMember>;
  page: SchedulePage;
}

export interface TeamMember {
  personId: Id;
  name: string;
}

export interface TeamBatchResult {
  added: Array<Id>;
  alreadyInTeam: Array<Id>;
}

export interface TeamBatchAdd {
  personIds: Array<Id>;
}

export interface TeamMembership {
  added: boolean;
}

export interface DepartmentList {
  items: Array<ScheduleDepartment>;
  page: SchedulePage;
}

export interface DepartmentCreate {
  name: string;
}

export interface DepartmentPatch {
  name?: string;
}

export interface RoleList {
  items: Array<ScheduleRole>;
  page: SchedulePage;
}

export interface RoleCreate {
  name: string;
}

export interface RolePatch {
  name?: string;
}

export interface TimeoffTypeList {
  items: Array<ScheduleTimeoffType>;
  page: SchedulePage;
}

export interface TimeoffTypeCreate {
  name: string;
  deducted?: boolean;
}

export interface TimeoffTypePatch {
  name?: string;
  deducted?: boolean;
}

export interface HolidayList {
  items: Array<ScheduleHoliday>;
  page: SchedulePage;
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

export interface ProjectList {
  items: Array<ProjectDetail>;
  page: SchedulePage;
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

export interface ClientList {
  items: Array<Client>;
  page: SchedulePage;
}

export interface Client {
  id: Id;
  version: Version;
  name: string;
  shortName: string | null;
  tags: Array<string>;
}

export interface ClientCreate {
  name: string;
  shortName?: string | null;
  tags?: Array<string>;
}

export interface ClientPatch {
  name?: string;
  shortName?: string | null;
  tags?: Array<string>;
}

export interface PhaseList {
  items: Array<Phase>;
  page: SchedulePage;
}

export interface Phase {
  id: Id;
  version: Version;
  projectId: Id;
  name: string;
  startDate: IsoDate | null;
  endDate: IsoDate | null;
  status: "tentative" | "planned" | "in_progress" | "on_hold" | "completed" | "archived";
  color: string | null;
  nonBillable: boolean;
  notes: string | null;
  position: number;
}

export interface PhaseCreate {
  projectId: Id;
  name: string;
  startDate?: IsoDate | null;
  endDate?: IsoDate | null;
  status?: "tentative" | "planned" | "in_progress" | "on_hold" | "completed" | "archived";
  color?: string | null;
  nonBillable?: boolean;
  notes?: string | null;
  position?: number;
}

export interface PhasePatch {
  name?: string;
  startDate?: IsoDate | null;
  endDate?: IsoDate | null;
  status?: "tentative" | "planned" | "in_progress" | "on_hold" | "completed" | "archived";
  color?: string | null;
  nonBillable?: boolean;
  notes?: string | null;
  position?: number;
}

export interface ProjectTaskList {
  items: Array<ProjectTask>;
  page: SchedulePage;
}

export interface ProjectTask {
  id: Id;
  version: Version;
  projectId: Id;
  phaseId: Id | null;
  name: string;
  billable: boolean;
  position: number;
}

export interface ProjectTaskCreate {
  projectId: Id;
  name: string;
  phaseId?: Id | null;
  billable?: boolean;
  position?: number;
}

export interface ProjectTaskPatch {
  name?: string;
  phaseId?: Id | null;
  billable?: boolean;
  position?: number;
}

export interface MilestoneList {
  items: Array<Milestone>;
  page: SchedulePage;
}

export interface Milestone {
  id: Id;
  version: Version;
  projectId: Id;
  phaseId: Id | null;
  name: string;
  dueDate: IsoDate;
}

export interface MilestoneCreate {
  projectId: Id;
  name: string;
  phaseId?: Id | null;
  dueDate: IsoDate;
}

export interface MilestonePatch {
  name?: string;
  phaseId?: Id | null;
  dueDate?: IsoDate;
}

export interface ProjectExpenseList {
  items: Array<ProjectExpense>;
  page: SchedulePage;
}

export interface ProjectExpense {
  id: Id;
  version: Version;
  projectId: Id;
  name: string;
  amount: string;
  currency: string;
  spentOn: IsoDate | null;
}

export interface ProjectExpenseCreate {
  projectId: Id;
  name: string;
  amount: string;
  currency?: string;
  spentOn?: IsoDate | null;
}

export interface ProjectExpensePatch {
  name?: string;
  amount?: string;
  currency?: string;
  spentOn?: IsoDate | null;
}

export interface ProjectBudgetLineList {
  items: Array<ProjectBudgetLine>;
  page: SchedulePage;
}

export interface ProjectBudgetLine {
  id: Id;
  version: Version;
  projectId: Id;
  taskId: Id | null;
  personId: Id | null;
  hours: number | null;
  amount: string | null;
}

export interface ProjectBudgetLineCreate {
  projectId: Id;
  taskId?: string;
  personId?: string;
  hours?: number;
  amount?: string;
}

export interface ProjectBudgetLinePatch {
  hours?: number | null;
  amount?: string | null;
}

export interface SavedViewList {
  items: Array<SavedView>;
  page: SchedulePage;
}

export interface SavedView {
  id: Id;
  version: Version;
  kind: SavedViewKind;
  name: string;
  filters: ScheduleViewFilters;
  shared: boolean;
  position: number;
  ownerId: string;
  canManage: boolean;
}

export type SavedViewKind = "schedule";

export interface ScheduleViewFilters {
  departmentIds?: Array<Id>;
  roleIds?: Array<Id>;
  projectIds?: Array<Id>;
  personIds?: Array<Id>;
  tags?: Array<string>;
  zoom?: SavedViewZoom;
  peopleSort?: "name" | "department" | "role";
}

export type SavedViewZoom = "day" | "week" | "month";

export interface SavedViewCreate {
  kind?: "schedule";
  name: string;
  filters?: {
    departmentIds?: Array<Id>;
    roleIds?: Array<Id>;
    projectIds?: Array<Id>;
    personIds?: Array<Id>;
    tags?: Array<string>;
    zoom?: SavedViewZoom;
    peopleSort?: "name" | "department" | "role";
  };
  shared?: boolean;
  position?: number;
}

export interface SavedViewPatch {
  name?: string;
  filters?: ScheduleViewFilters;
  shared?: boolean;
  position?: number;
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
    /** Ticket d'upgrade du temps reel (usage unique, 30 s) pour les clients qui ne peuvent pas poser d'en-tete sur un WebSocket ; tout membre authentifie (POST /api/v1/realtime/ticket) */
    async createRealtimeTicket(): Promise<ApiResult<RealtimeTicket, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/realtime/ticket", { method: "POST", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as RealtimeTicket }
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
    /** Lire une allocation (avec sa version ; tout membre authentifie) (GET /api/v1/allocations/{id}) */
    async getAllocation(input: {
      path: {
        id: Id;
      };
    }): Promise<ApiResult<ScheduleAllocation, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/allocations/" + encodeURIComponent(String(input.path.id)), { method: "GET", headers: { accept: "application/json" } });
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
    /** Allocations d'un projet sur une fenetre (chevauchement ; pagine, tri par id ; tout membre authentifie) (GET /api/v1/projects/{projectId}/allocations) */
    async listProjectAllocations(input: {
      path: {
        projectId: Id;
      };
      query: {
        limit?: number;
        cursor?: string;
        from: string;
        to: string;
        personId?: string;
        status?: "tentative" | "confirmed";
      };
    }): Promise<ApiResult<ProjectAllocationList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/projects/" + encodeURIComponent(String(input.path.projectId)) + "/allocations" + toQueryString(input.query), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ProjectAllocationList }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Creer une allocation multi-personnes (BR-26) : une ligne par membre, un groupId commun, tout ou rien (POST /api/v1/allocation-groups) */
    async createAllocationGroup(input: {
      body: AllocationGroupCreate;
    }): Promise<ApiResult<AllocationGroup, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/allocation-groups", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as AllocationGroup }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Modifier TOUTES les lignes du groupe de l'allocation (champs communs ; verrou optimiste sur la ligne designee) (PATCH /api/v1/allocations/{id}/group) */
    async updateAllocationGroup(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
      body: AllocationGroupPatch;
    }): Promise<ApiResult<AllocationGroup, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/allocations/" + encodeURIComponent(String(input.path.id)) + "/group", { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", ...input.headers }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as AllocationGroup }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Supprimer TOUTES les lignes du groupe de l'allocation (verrou optimiste sur la ligne designee) (DELETE /api/v1/allocations/{id}/group) */
    async deleteAllocationGroup(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
    }): Promise<ApiResult<void, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/allocations/" + encodeURIComponent(String(input.path.id)) + "/group", { method: "DELETE", headers: { accept: "application/json", ...input.headers } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as void }
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
    /** Modifier ou supprimer UNE occurrence d'une serie repetee : decoupe en avant / occurrence / apres (verrou optimiste sur la serie) (POST /api/v1/allocations/{id}/split) */
    async splitAllocation(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
      body: AllocationSplit;
    }): Promise<ApiResult<AllocationSplitResult, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/allocations/" + encodeURIComponent(String(input.path.id)) + "/split", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", ...input.headers }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as AllocationSplitResult }
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
    /** Lister les temps saisis d'une personne sur une fenetre (tout membre authentifie) (GET /api/v1/logged-time) */
    async listLoggedTime(query: {
      personId: Id;
      from: string;
      to: string;
      status?: "draft" | "submitted" | "approved" | "locked";
    }): Promise<ApiResult<LoggedTimeList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/logged-time" + toQueryString(query), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as LoggedTimeList }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Saisir un temps (brouillon) ; total par jour <= 24 h (BR-28) (POST /api/v1/logged-time) */
    async createLoggedTime(input: {
      body: LoggedTimeCreate;
    }): Promise<ApiResult<LoggedTime, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/logged-time", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as LoggedTime }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Modifier un brouillon (verrou optimiste If-Match) (PATCH /api/v1/logged-time/{id}) */
    async updateLoggedTime(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
      body: LoggedTimePatch;
    }): Promise<ApiResult<LoggedTime, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/logged-time/" + encodeURIComponent(String(input.path.id)), { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", ...input.headers }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as LoggedTime }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Supprimer un brouillon (verrou optimiste If-Match) (DELETE /api/v1/logged-time/{id}) */
    async deleteLoggedTime(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
    }): Promise<ApiResult<void, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/logged-time/" + encodeURIComponent(String(input.path.id)), { method: "DELETE", headers: { accept: "application/json", ...input.headers } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as void }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Pre-remplir la fenetre depuis les allocations confirmees (BR-11) ; idempotent (POST /api/v1/logged-time/prefill) */
    async prefillLoggedTime(input: {
      body: LoggedTimeWindow;
    }): Promise<ApiResult<LoggedTimePrefillResult, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/logged-time/prefill", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as LoggedTimePrefillResult }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Soumettre (et verrouiller, BR-12) tous les brouillons d'une personne sur une fenetre, atomiquement (POST /api/v1/logged-time/submit) */
    async submitLoggedTime(input: {
      body: LoggedTimeWindow;
    }): Promise<ApiResult<LoggedTimeSubmitResult, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/logged-time/submit", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as LoggedTimeSubmitResult }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Deverrouiller une ligne soumise (owner ou admin, trace en base, BR-12) (POST /api/v1/logged-time/{id}/unlock) */
    async unlockLoggedTime(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
    }): Promise<ApiResult<LoggedTime, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/logged-time/" + encodeURIComponent(String(input.path.id)) + "/unlock", { method: "POST", headers: { accept: "application/json", ...input.headers } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as LoggedTime }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Lister les personnes (pagine, tri par id ; actives par defaut ; tout membre authentifie) (GET /api/v1/people) */
    async listPeople(query: {
      limit?: number;
      cursor?: string;
      departmentId?: string;
      roleId?: string;
      tag?: string;
      search?: string;
      includeInactive?: boolean;
    } = {}): Promise<ApiResult<PersonList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/people" + toQueryString(query), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as PersonList }
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
    /** Lire une personne (desactivee comprise, avec sa version ; tout membre authentifie) (GET /api/v1/people/{id}) */
    async getPerson(input: {
      path: {
        id: Id;
      };
    }): Promise<ApiResult<SchedulePerson, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/people/" + encodeURIComponent(String(input.path.id)), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as SchedulePerson }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Modifier ou desactiver une personne (verrou optimiste If-Match ; pas de suppression ; horaire, departement et role a effet date via effectiveFrom, BR-19) (PATCH /api/v1/people/{id}) */
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
    /** Projets d'une personne : equipe ou allocations (pagine, tri par id de projet ; archives exclus par defaut ; tout membre authentifie) (GET /api/v1/people/{id}/projects) */
    async listPersonProjects(input: {
      path: {
        id: Id;
      };
      query?: {
        limit?: number;
        cursor?: string;
        status?: "tentative" | "planned" | "in_progress" | "on_hold" | "completed" | "archived";
      };
    }): Promise<ApiResult<PersonProjectList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/people/" + encodeURIComponent(String(input.path.id)) + "/projects" + toQueryString(input.query ?? {}), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as PersonProjectList }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Historique date d'une personne : periodes de l'horaire, du departement et du role (BR-19 ; pagine, tri par id ; tout membre authentifie) (GET /api/v1/people/{id}/history) */
    async listPersonHistory(input: {
      path: {
        id: Id;
      };
      query?: {
        limit?: number;
        cursor?: string;
        attribute?: "workDaysHours" | "departmentId" | "roleId";
      };
    }): Promise<ApiResult<PersonHistoryList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/people/" + encodeURIComponent(String(input.path.id)) + "/history" + toQueryString(input.query ?? {}), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as PersonHistoryList }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Recapitulatif de la desactivation d'une personne (BR-31) : ses allocations futures, sans rien ecrire (owner, admin ou project_manager) (GET /api/v1/people/{id}/deactivation-summary) */
    async getPersonDeactivationSummary(input: {
      path: {
        id: Id;
      };
      query?: {
        asOf?: string;
      };
    }): Promise<ApiResult<PersonDeactivationSummary, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/people/" + encodeURIComponent(String(input.path.id)) + "/deactivation-summary" + toQueryString(input.query ?? {}), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as PersonDeactivationSummary }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Desactiver une personne et reaffecter ou supprimer ses allocations futures, apres confirmation (BR-31) (POST /api/v1/people/{id}/deactivation) */
    async deactivatePerson(input: {
      path: {
        id: Id;
      };
      body: PersonDeactivationRequest;
    }): Promise<ApiResult<PersonDeactivationResult, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/people/" + encodeURIComponent(String(input.path.id)) + "/deactivation", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as PersonDeactivationResult }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Allocations d'une personne sur une fenetre (chevauchement ; pagine, tri par id ; tout membre authentifie) (GET /api/v1/people/{id}/allocations) */
    async listPersonAllocations(input: {
      path: {
        id: Id;
      };
      query: {
        limit?: number;
        cursor?: string;
        from: string;
        to: string;
        projectId?: string;
        status?: "tentative" | "confirmed";
      };
    }): Promise<ApiResult<PersonAllocationList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/people/" + encodeURIComponent(String(input.path.id)) + "/allocations" + toQueryString(input.query), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as PersonAllocationList }
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
    /** Equipe d'un projet (pagine, tri par personId ; tout membre authentifie) (GET /api/v1/projects/{projectId}/team) */
    async listProjectTeam(input: {
      path: {
        projectId: Id;
      };
      query?: {
        limit?: number;
        cursor?: string;
      };
    }): Promise<ApiResult<TeamMemberList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/projects/" + encodeURIComponent(String(input.path.projectId)) + "/team" + toQueryString(input.query ?? {}), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as TeamMemberList }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Ajouter plusieurs personnes a l'equipe d'un projet (une transaction, tout ou rien, idempotent) (POST /api/v1/projects/{projectId}/team) */
    async addManyToTeam(input: {
      path: {
        projectId: Id;
      };
      body: TeamBatchAdd;
    }): Promise<ApiResult<TeamBatchResult, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/projects/" + encodeURIComponent(String(input.path.projectId)) + "/team", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as TeamBatchResult }
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
    /** Lister : departement (pagine, tri par id ; tout membre authentifie) (GET /api/v1/departments) */
    async listDepartments(query: {
      limit?: number;
      cursor?: string;
    } = {}): Promise<ApiResult<DepartmentList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/departments" + toQueryString(query), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as DepartmentList }
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
    /** Lire : departement (tout membre authentifie) (GET /api/v1/departments/{id}) */
    async getDepartment(input: {
      path: {
        id: Id;
      };
    }): Promise<ApiResult<ScheduleDepartment, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/departments/" + encodeURIComponent(String(input.path.id)), { method: "GET", headers: { accept: "application/json" } });
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
    /** Lister : role (pagine, tri par id ; tout membre authentifie) (GET /api/v1/roles) */
    async listRoles(query: {
      limit?: number;
      cursor?: string;
    } = {}): Promise<ApiResult<RoleList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/roles" + toQueryString(query), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as RoleList }
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
    /** Lire : role (tout membre authentifie) (GET /api/v1/roles/{id}) */
    async getRole(input: {
      path: {
        id: Id;
      };
    }): Promise<ApiResult<ScheduleRole, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/roles/" + encodeURIComponent(String(input.path.id)), { method: "GET", headers: { accept: "application/json" } });
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
    /** Lister : type de conge (pagine, tri par id ; tout membre authentifie) (GET /api/v1/timeoff-types) */
    async listTimeoffTypes(query: {
      limit?: number;
      cursor?: string;
    } = {}): Promise<ApiResult<TimeoffTypeList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/timeoff-types" + toQueryString(query), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as TimeoffTypeList }
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
    /** Lire : type de conge (tout membre authentifie) (GET /api/v1/timeoff-types/{id}) */
    async getTimeoffType(input: {
      path: {
        id: Id;
      };
    }): Promise<ApiResult<ScheduleTimeoffType, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/timeoff-types/" + encodeURIComponent(String(input.path.id)), { method: "GET", headers: { accept: "application/json" } });
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
    /** Lister : jour ferie (pagine, tri par id ; tout membre authentifie) (GET /api/v1/holidays) */
    async listHolidays(query: {
      limit?: number;
      cursor?: string;
      from?: string;
      to?: string;
    } = {}): Promise<ApiResult<HolidayList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/holidays" + toQueryString(query), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as HolidayList }
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
    /** Lire : jour ferie (tout membre authentifie) (GET /api/v1/holidays/{id}) */
    async getHoliday(input: {
      path: {
        id: Id;
      };
    }): Promise<ApiResult<ScheduleHoliday, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/holidays/" + encodeURIComponent(String(input.path.id)), { method: "GET", headers: { accept: "application/json" } });
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
    /** Lister : projet (pagine, tri par id ; tout membre authentifie) (GET /api/v1/projects) */
    async listProjects(query: {
      limit?: number;
      cursor?: string;
      status?: "tentative" | "planned" | "in_progress" | "on_hold" | "completed" | "archived";
    } = {}): Promise<ApiResult<ProjectList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/projects" + toQueryString(query), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ProjectList }
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
    /** Lire : projet (tout membre authentifie) (GET /api/v1/projects/{id}) */
    async getProject(input: {
      path: {
        id: Id;
      };
    }): Promise<ApiResult<ProjectDetail, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/projects/" + encodeURIComponent(String(input.path.id)), { method: "GET", headers: { accept: "application/json" } });
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
    /** Lister : client (pagine, tri par id ; tout membre authentifie) (GET /api/v1/clients) */
    async listClients(query: {
      limit?: number;
      cursor?: string;
    } = {}): Promise<ApiResult<ClientList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/clients" + toQueryString(query), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ClientList }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Creer : client (POST /api/v1/clients) */
    async createClient(input: {
      body: ClientCreate;
    }): Promise<ApiResult<Client, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/clients", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as Client }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Lire : client (tout membre authentifie) (GET /api/v1/clients/{id}) */
    async getClient(input: {
      path: {
        id: Id;
      };
    }): Promise<ApiResult<Client, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/clients/" + encodeURIComponent(String(input.path.id)), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as Client }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Modifier : client (verrou optimiste If-Match) (PATCH /api/v1/clients/{id}) */
    async updateClient(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
      body: ClientPatch;
    }): Promise<ApiResult<Client, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/clients/" + encodeURIComponent(String(input.path.id)), { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", ...input.headers }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as Client }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Supprimer : client (verrou optimiste If-Match ; refuse si reference) (DELETE /api/v1/clients/{id}) */
    async deleteClient(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
    }): Promise<ApiResult<void, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/clients/" + encodeURIComponent(String(input.path.id)), { method: "DELETE", headers: { accept: "application/json", ...input.headers } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as void }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Lister : phase (pagine, tri par id ; tout membre authentifie) (GET /api/v1/phases) */
    async listPhases(query: {
      limit?: number;
      cursor?: string;
      projectId?: string;
    } = {}): Promise<ApiResult<PhaseList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/phases" + toQueryString(query), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as PhaseList }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Creer : phase (POST /api/v1/phases) */
    async createPhase(input: {
      body: PhaseCreate;
    }): Promise<ApiResult<Phase, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/phases", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as Phase }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Lire : phase (tout membre authentifie) (GET /api/v1/phases/{id}) */
    async getPhase(input: {
      path: {
        id: Id;
      };
    }): Promise<ApiResult<Phase, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/phases/" + encodeURIComponent(String(input.path.id)), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as Phase }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Modifier : phase (verrou optimiste If-Match) (PATCH /api/v1/phases/{id}) */
    async updatePhase(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
      body: PhasePatch;
    }): Promise<ApiResult<Phase, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/phases/" + encodeURIComponent(String(input.path.id)), { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", ...input.headers }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as Phase }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Supprimer : phase (verrou optimiste If-Match ; refuse si reference) (DELETE /api/v1/phases/{id}) */
    async deletePhase(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
    }): Promise<ApiResult<void, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/phases/" + encodeURIComponent(String(input.path.id)), { method: "DELETE", headers: { accept: "application/json", ...input.headers } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as void }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Lister : tache de projet (pagine, tri par id ; tout membre authentifie) (GET /api/v1/project-tasks) */
    async listProjectTasks(query: {
      limit?: number;
      cursor?: string;
      projectId?: string;
      phaseId?: string;
    } = {}): Promise<ApiResult<ProjectTaskList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/project-tasks" + toQueryString(query), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ProjectTaskList }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Creer : tache de projet (POST /api/v1/project-tasks) */
    async createProjectTask(input: {
      body: ProjectTaskCreate;
    }): Promise<ApiResult<ProjectTask, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/project-tasks", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ProjectTask }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Lire : tache de projet (tout membre authentifie) (GET /api/v1/project-tasks/{id}) */
    async getProjectTask(input: {
      path: {
        id: Id;
      };
    }): Promise<ApiResult<ProjectTask, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/project-tasks/" + encodeURIComponent(String(input.path.id)), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ProjectTask }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Modifier : tache de projet (verrou optimiste If-Match) (PATCH /api/v1/project-tasks/{id}) */
    async updateProjectTask(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
      body: ProjectTaskPatch;
    }): Promise<ApiResult<ProjectTask, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/project-tasks/" + encodeURIComponent(String(input.path.id)), { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", ...input.headers }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ProjectTask }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Supprimer : tache de projet (verrou optimiste If-Match ; refuse si reference) (DELETE /api/v1/project-tasks/{id}) */
    async deleteProjectTask(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
    }): Promise<ApiResult<void, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/project-tasks/" + encodeURIComponent(String(input.path.id)), { method: "DELETE", headers: { accept: "application/json", ...input.headers } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as void }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Lister : jalon (pagine, tri par id ; tout membre authentifie) (GET /api/v1/milestones) */
    async listMilestones(query: {
      limit?: number;
      cursor?: string;
      projectId?: string;
      phaseId?: string;
      dueFrom?: string;
      dueTo?: string;
    } = {}): Promise<ApiResult<MilestoneList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/milestones" + toQueryString(query), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as MilestoneList }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Creer : jalon (POST /api/v1/milestones) */
    async createMilestone(input: {
      body: MilestoneCreate;
    }): Promise<ApiResult<Milestone, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/milestones", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as Milestone }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Lire : jalon (tout membre authentifie) (GET /api/v1/milestones/{id}) */
    async getMilestone(input: {
      path: {
        id: Id;
      };
    }): Promise<ApiResult<Milestone, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/milestones/" + encodeURIComponent(String(input.path.id)), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as Milestone }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Modifier : jalon (verrou optimiste If-Match) (PATCH /api/v1/milestones/{id}) */
    async updateMilestone(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
      body: MilestonePatch;
    }): Promise<ApiResult<Milestone, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/milestones/" + encodeURIComponent(String(input.path.id)), { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", ...input.headers }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as Milestone }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Supprimer : jalon (verrou optimiste If-Match ; refuse si reference) (DELETE /api/v1/milestones/{id}) */
    async deleteMilestone(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
    }): Promise<ApiResult<void, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/milestones/" + encodeURIComponent(String(input.path.id)), { method: "DELETE", headers: { accept: "application/json", ...input.headers } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as void }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Lister : depense de projet (pagine, tri par id ; owner, admin ou project_manager) (GET /api/v1/project-expenses) */
    async listProjectExpenses(query: {
      limit?: number;
      cursor?: string;
      projectId?: string;
      spentFrom?: string;
      spentTo?: string;
    } = {}): Promise<ApiResult<ProjectExpenseList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/project-expenses" + toQueryString(query), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ProjectExpenseList }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Creer : depense de projet (POST /api/v1/project-expenses) */
    async createProjectExpense(input: {
      body: ProjectExpenseCreate;
    }): Promise<ApiResult<ProjectExpense, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/project-expenses", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ProjectExpense }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Lire : depense de projet (owner, admin ou project_manager) (GET /api/v1/project-expenses/{id}) */
    async getProjectExpense(input: {
      path: {
        id: Id;
      };
    }): Promise<ApiResult<ProjectExpense, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/project-expenses/" + encodeURIComponent(String(input.path.id)), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ProjectExpense }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Modifier : depense de projet (verrou optimiste If-Match) (PATCH /api/v1/project-expenses/{id}) */
    async updateProjectExpense(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
      body: ProjectExpensePatch;
    }): Promise<ApiResult<ProjectExpense, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/project-expenses/" + encodeURIComponent(String(input.path.id)), { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", ...input.headers }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ProjectExpense }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Supprimer : depense de projet (verrou optimiste If-Match ; refuse si reference) (DELETE /api/v1/project-expenses/{id}) */
    async deleteProjectExpense(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
    }): Promise<ApiResult<void, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/project-expenses/" + encodeURIComponent(String(input.path.id)), { method: "DELETE", headers: { accept: "application/json", ...input.headers } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as void }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Lister : ligne de budget (pagine, tri par id ; owner, admin ou project_manager) (GET /api/v1/project-budget-lines) */
    async listProjectBudgetLines(query: {
      limit?: number;
      cursor?: string;
      projectId?: string;
      taskId?: string;
      personId?: string;
    } = {}): Promise<ApiResult<ProjectBudgetLineList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/project-budget-lines" + toQueryString(query), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ProjectBudgetLineList }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Creer : ligne de budget (POST /api/v1/project-budget-lines) */
    async createProjectBudgetLine(input: {
      body: ProjectBudgetLineCreate;
    }): Promise<ApiResult<ProjectBudgetLine, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/project-budget-lines", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ProjectBudgetLine }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Lire : ligne de budget (owner, admin ou project_manager) (GET /api/v1/project-budget-lines/{id}) */
    async getProjectBudgetLine(input: {
      path: {
        id: Id;
      };
    }): Promise<ApiResult<ProjectBudgetLine, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/project-budget-lines/" + encodeURIComponent(String(input.path.id)), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ProjectBudgetLine }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Modifier : ligne de budget (verrou optimiste If-Match) (PATCH /api/v1/project-budget-lines/{id}) */
    async updateProjectBudgetLine(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
      body: ProjectBudgetLinePatch;
    }): Promise<ApiResult<ProjectBudgetLine, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/project-budget-lines/" + encodeURIComponent(String(input.path.id)), { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", ...input.headers }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as ProjectBudgetLine }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Supprimer : ligne de budget (verrou optimiste If-Match ; refuse si reference) (DELETE /api/v1/project-budget-lines/{id}) */
    async deleteProjectBudgetLine(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
    }): Promise<ApiResult<void, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/project-budget-lines/" + encodeURIComponent(String(input.path.id)), { method: "DELETE", headers: { accept: "application/json", ...input.headers } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as void }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Lister mes vues et les vues partagees du compte (pagine, tri par id ; tout membre authentifie) (GET /api/v1/saved-views) */
    async listSavedViews(query: {
      limit?: number;
      cursor?: string;
      kind?: SavedViewKind;
    } = {}): Promise<ApiResult<SavedViewList, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/saved-views" + toQueryString(query), { method: "GET", headers: { accept: "application/json" } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as SavedViewList }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Creer une vue (privee ; partagee : owner, admin ou project_manager) (POST /api/v1/saved-views) */
    async createSavedView(input: {
      body: SavedViewCreate;
    }): Promise<ApiResult<SavedView, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/saved-views", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as SavedView }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Modifier une vue (verrou optimiste If-Match ; proprietaire, ou owner/admin pour une vue partagee) (PATCH /api/v1/saved-views/{id}) */
    async updateSavedView(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
      body: SavedViewPatch;
    }): Promise<ApiResult<SavedView, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/saved-views/" + encodeURIComponent(String(input.path.id)), { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", ...input.headers }, body: JSON.stringify(input.body) });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as SavedView }
        : { ok: false, status: res.status, error: body as ApiError };
    },
    /** Supprimer une vue (verrou optimiste If-Match ; memes droits que la modification) (DELETE /api/v1/saved-views/{id}) */
    async deleteSavedView(input: {
      path: {
        id: Id;
      };
      headers: {
        "If-Match": string;
      };
    }): Promise<ApiResult<void, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/saved-views/" + encodeURIComponent(String(input.path.id)), { method: "DELETE", headers: { accept: "application/json", ...input.headers } });
      const body = res.status === 204 ? undefined : await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as void }
        : { ok: false, status: res.status, error: body as ApiError };
    },
  };
}
