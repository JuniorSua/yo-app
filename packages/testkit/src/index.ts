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
  FAKE_OAUTH_TOKEN,
  SETUP_TOKEN_TRANSCRIPT_PREFIX,
  SETUP_TOKEN_URL,
  setupTokenTranscript,
} from "./fixtures/setupToken";
export { FAKE_CODEX_SCRIPT, FAKE_GROK_SCRIPT, fakeCodexCommand, fakeGrokCommand } from "./node-cmd";
