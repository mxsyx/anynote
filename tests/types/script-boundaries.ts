import type {
  ScriptState,
  StatefulMarkdownTransformResult,
} from "../../packages/plugin-sdk/src/declarative.js";
import { validateStatefulResult } from "../../packages/plugin-sdk/src/script-state.js";
import { validateScriptSearchContext } from "../../packages/plugin-sdk/src/script-search.js";
import { validateScriptNetworkResult } from "../../packages/plugin-sdk/src/script-network.js";
import type {
  Proposal,
  ProposalOperation,
  proposalOperation,
} from "../../packages/storage-sqlite/src/proposals.js";

export function scriptBoundaries(raw: unknown, proposal: Proposal) {
  const output: StatefulMarkdownTransformResult = validateStatefulResult(raw);
  const body: string = output.body;
  const state: ScriptState = output.state;

  // @ts-expect-error Script output cannot silently become any.
  const number: number = output.body;

  // @ts-expect-error JSON state cannot contain functions.
  state.callback = () => true;
  const search = validateScriptSearchContext(raw);

  // @ts-expect-error Search projection revisions are numeric.
  const revision: string = search.results[0].revision;
  const network = validateScriptNetworkResult(raw);

  // @ts-expect-error Network results contain bounded text, not arbitrary fields.
  void network.token;

  // @ts-expect-error Proposal operations cannot dispatch arbitrary storage commands.
  const operation: ProposalOperation = "deleteNotebook";
  if (proposal.status === "proposed") {
    // @ts-expect-error Proposed state has no applied revision.
    void proposal.appliedRevision;
  } else {
    const applied: number = proposal.appliedRevision;
    void applied;
  }
  void [body, number, state, revision, operation];
}

export function proposalResult(result: ReturnType<typeof proposalOperation>) {
  // @ts-expect-error Dispatch results are validated records, never untyped scalars.
  const scalar: number = result;
  void scalar;
}
