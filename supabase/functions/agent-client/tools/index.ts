/**
 * # Tools
 *
 * ## Simple tools
 *
 * - Functions
 *
 *   Do not require configuration.
 *
 *   - Utils like calculator, calendar.
 *   - Core function like handle_conversation.
 *
 * - MCP
 *
 *   External tools. The tools do not require config, the MCP server does.
 *
 * ## Special tools
 *
 * - HTTP
 * - SQL
 * - Agent
 *
 *   Use an agent as tool. The conversation returns to the agent which made the call.
 */

import { HTTPTools } from "./http.ts";
import { SQLTools } from "./sql.ts";
import { CalculatorTool } from "./calculator.ts";
import { TransferToHumanAgentTool } from "./handoff.ts";

const FunctionTools = [CalculatorTool, TransferToHumanAgentTool];
const CustomTools: any[] = [];

export const Toolbox = {
  function: FunctionTools,
  custom: CustomTools,
  http: HTTPTools,
  sql: SQLTools,
};
