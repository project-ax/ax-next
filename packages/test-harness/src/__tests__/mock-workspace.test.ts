import { runWorkspaceContract } from '../workspace-contract.js';
import { createMockWorkspacePlugin } from '../mock-workspace.js';

runWorkspaceContract('MockWorkspace', createMockWorkspacePlugin);
