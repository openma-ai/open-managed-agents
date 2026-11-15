import { expect, it } from "vitest";
import { sessionEventSendBodySchema } from "../src/contracts/session-events";
const definition = {type:"user.define_outcome",description:"proof",rubric:{type:"text",content:"exists"}};
it("retains the public rubric outcome contract",()=>{
 expect(sessionEventSendBodySchema.parse({events:[definition]})).toEqual({events:[definition]});
});
it.each(["verifier", "_oma"])("does not silently expand public outcome input with %s",key=>{
 const verifier={type:"script",verify_script:"test -f proof"};
 expect(sessionEventSendBodySchema.safeParse({events:[{...definition,[key]:key==="_oma"?{verifier}:verifier}]}).success).toBe(false);
});
