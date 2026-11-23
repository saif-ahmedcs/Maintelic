import { RoleName } from './entities/role.entity';

export const WORK_ORDER_ASSIGNEE_ROLES: readonly RoleName[] = [
  RoleName.ADMIN,
  RoleName.SUPERVISOR,
  RoleName.TECHNICIAN,
];

export function hasWorkOrderAssigneeRole(
  roles: ReadonlyArray<{ name: RoleName }>,
): boolean {
  return roles.some((role) => WORK_ORDER_ASSIGNEE_ROLES.includes(role.name));
}
