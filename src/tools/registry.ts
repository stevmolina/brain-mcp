import { z } from 'zod';
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export type ToolCallContext = Pick<ServerContext, 'http'>;
export interface OperationConfig<S extends z.ZodObject> {
  title?: string;
  description?: string;
  inputSchema: S;
  annotations?: Record<string, boolean>;
}
export interface ToolRegistrar {
  registerTool<S extends z.ZodObject>(
    name: string, config: OperationConfig<S>,
    handler: ((args: z.output<S>, context: ToolCallContext) => Promise<CallToolResult>) & { domainHandler?: (args: z.output<S>, context: ToolCallContext) => Promise<CallToolResult> },
  ): void;
  registerResource?: McpServer['registerResource'];
}
export interface Operation {
  schema: z.ZodObject;
  description: string;
  invoke: (input: unknown, context: ToolCallContext) => Promise<CallToolResult>;
}
export class OperationRegistry implements ToolRegistrar {
  readonly operations = new Map<string, Operation>();
  registerTool<S extends z.ZodObject>(
    name: string, config: OperationConfig<S>,
    handler: ((args: z.output<S>, context: ToolCallContext) => Promise<CallToolResult>) & { domainHandler?: (args: z.output<S>, context: ToolCallContext) => Promise<CallToolResult> },
  ): void {
    this.operations.set(name, {
      schema: config.inputSchema,
      description: config.description ?? name,
      invoke: (input, context) => (handler.domainHandler ?? handler)(config.inputSchema.parse(input), context),
    });
  }
}
