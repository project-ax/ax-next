export const WORKSPACE_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export class InvalidWorkspaceIdError extends Error {
  constructor() {
    super('invalid workspaceId');
    this.name = 'InvalidWorkspaceIdError';
  }
}

export function validateWorkspaceId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !WORKSPACE_ID_REGEX.test(id)) {
    throw new InvalidWorkspaceIdError();
  }
}
