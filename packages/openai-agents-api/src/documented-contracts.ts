import { sdkContractDescriptors, sdkContractRoots } from './sdk-contracts.generated';

export type Descriptor = { kind: string; value?: unknown; variants?: string[]; element?: string; properties?: Record<string, { schema: string; required: boolean }>; additional?: string; maxLength?: number; maxItems?: number };

/** Add documented contracts newer than the pinned SDK, without editing its
 * generated declarations. Source: openai/openai-openapi openapi.yaml,
 * 2026-11-04, SHA256 2213c5372faf662dd32dc91b2b2acdcf455df609c6fe9ab3a3413674f8b46449.
 * Schemas: SessionReviewParam, ContainerSizeParam, SessionInputParam,
 * ComputerUseApprovalResponseParam and BrowserAuthenticationFieldValueParam. */
export function documentedDescriptors(): Record<string, Descriptor> {
  const schemas: Record<string, Descriptor> = structuredClone(sdkContractDescriptors);
  let index = 0;
  const add = (schema: Descriptor): string => { const id = `documented_${index++}`; schemas[id] = schema; return id; };
  const literal = (value: string) => add({ kind: 'literal', value });
  const union = (...variants: string[]) => add({ kind: 'union', variants });
  const string = (maxLength?: number) => add({ kind: 'string', ...(maxLength !== undefined && { maxLength }) });
  const object = (fields: Record<string, string>, optional: string[] = []) => add({ kind: 'object', properties: Object.fromEntries(Object.entries(fields).map(([name, schema]) => [name, { schema, required: !optional.includes(name) }])) });
  const review = union(literal('none'), literal('auto_review'));
  const size = union(literal('small'), literal('medium'), literal('large'));
  for (const [name, id] of Object.entries(sdkContractRoots)) {
    if (name.startsWith('sessions.SessionCreateParams') && schemas[id].properties) schemas[id].properties!.review = { schema: review, required: false };
  }
  for (const id of schemas[sdkContractRoots['agents.EnvironmentParam']].variants!) {
    const properties = schemas[id].properties;
    if (properties?.type && schemas[properties.type.schema].value === 'openai_hosted') properties.container_size = { schema: size, required: false };
  }
  const auth = literal('browser_authentication');
  const field = object({ field_id: string(), value: string(16384) });
  const submit = object({ type: auth, action: literal('submit'), fields: add({ kind: 'array', element: field, maxItems: 6 }), selected_option: union(string(), add({ kind: 'null' })) }, ['selected_option']);
  const cancel = object({ type: auth, action: literal('cancel') });
  const origin = object({ type: literal('browser_origin_access'), decision: union(literal('approve'), literal('deny'), literal('cancel')) });
  const approval = object({ type: literal('agent.session.input.computer_use_approval_request_result'), request_id: string(), response: union(submit, cancel, origin) });
  schemas[sdkContractRoots['agents.AgentSessionInputParam']].variants!.push(approval);
  return schemas;
}
