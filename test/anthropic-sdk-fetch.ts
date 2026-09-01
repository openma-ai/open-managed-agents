/**
 * Anthropic's SDK probes custom fetch implementations by constructing a
 * Response from FormData and calling .text(). Workerd warns because multipart
 * bodies are not text. Supplying the optional Response constructor lets the
 * probe succeed without decoding the multipart payload.
 */
class FormDataCapabilityResponse extends Response {
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body instanceof FormData ? "form-data-supported" : body, init);
  }
}

export function withAnthropicFormDataSupport(fetchImpl: typeof fetch): typeof fetch {
  return Object.assign(fetchImpl, { Response: FormDataCapabilityResponse });
}
