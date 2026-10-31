/**
 * @yo/testkit — fakes and fixtures for provider adapter tests.
 */
export {
  CLAUDE_ASK_FIXTURE,
  createFakeClaudeQuery,
  createReplayClaudeQuery,
  FAKE_CLAUDE_INIT,
  type FakeClaudeCall,
  type FakeQuery,
} from "./fake-claude";
export {
  CLAUDE_LOGIN_FAILED_TAIL,
  CLAUDE_LOGIN_STATE,
  CLAUDE_LOGIN_SUCCESS_TAIL,
  CLAUDE_LOGIN_URL,
  claudeLoginPrompt,
  FAKE_CLAUDE_LOGIN_CODE,
} from "./fixtures/claudeLogin";
export { FAKE_CODEX_SCRIPT, FAKE_GROK_SCRIPT, fakeCodexCommand, fakeGrokCommand } from "./node-cmd";
