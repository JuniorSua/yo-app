import type { AgentView } from "@yo/contracts";
import { toast } from "sonner";
import { run } from "../stores/sync";
import { api } from "./api";

/** "Steer now" on a queued message. */
export async function steerQueued(agent: AgentView, id: string) {
  const res = await run(api().call("queue.steer", { agentId: agent.id, id }), "Couldn't steer");
  if (!res) return;
  if (res.steered) toast.success(`Sent to ${agent.name} mid-task`);
  else toast(res.note ?? `${agent.name} will start it next.`);
}
