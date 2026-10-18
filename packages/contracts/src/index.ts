export const CONTRACTS_VERSION = "0.0.0";
export { ApiError, ErrorCode } from "./errors";
export { HealthResponse } from "./health";
export { routes } from "./routes";
export type { RouteContract } from "./routes";
export { Id, IsoDate, Version } from "./common";
export { AllocationCreate, AllocationLoad, AllocationPatch, AllocationPathParams, IfMatchHeader } from "./allocations";
export {
  ScheduleAccount, ScheduleAllocation, ScheduleDepartment, ScheduleHoliday, SchedulePage, SchedulePeopleType,
  SchedulePerson, ScheduleProject, ScheduleQuery, ScheduleResponse, ScheduleRole, ScheduleTimeoff, ScheduleTimeoffType,
} from "./schedule";
export {
  Change, ChangeEntity, REALTIME_PATH, REALTIME_PROTOCOL_VERSION, REALTIME_RETRY_AFTER_SECONDS, REALTIME_TICKET_PARAM, REALTIME_TICKET_PATH, REALTIME_TICKET_TTL_SECONDS, REALTIME_UPGRADE_STATUS, RealtimeChanges, RealtimeClientMessage, RealtimeError,
  RealtimeReady, RealtimeResync, RealtimeServerMessage, RealtimeSubscribe, RealtimeTicket,
} from "./realtime";
export { TimeoffCreate, TimeoffPatch, TimeoffPathParams } from "./timeoffs";
export { PersonCreate, PersonPatch, PersonPathParams } from "./people";
export { TEAM_BATCH_MAX, TeamBatchAdd, TeamBatchResult, TeamMember, TeamMemberList, TeamMembership, TeamPathParams, TeamProjectPathParams, TeamRemovalConfirmation, TeamRemovalRequest, TeamRemovalResult, TeamRemovalSummary } from "./team";
export {
  DepartmentCreate, DepartmentList, DepartmentPatch, HolidayCreate, HolidayList, HolidayListQuery, HolidayPatch, ProjectCreate, ProjectDetail,
  ProjectList, ProjectListQuery, ProjectPatch, ReferenceListQuery, ReferencePathParams, RoleCreate, RoleList, RolePatch, TimeoffTypeCreate,
  TimeoffTypeList, TimeoffTypePatch,
} from "./reference";
export {
  Client, ClientCreate, ClientList, ClientPatch, Phase, PhaseCreate, PhaseList, PhaseListQuery, PhasePatch, ProjectTask, ProjectTaskCreate,
  ProjectTaskList, ProjectTaskListQuery, ProjectTaskPatch,
} from "./project-structure";
