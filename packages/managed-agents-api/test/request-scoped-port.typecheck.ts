import type {
  ApplicationPortResolver,
  ApplicationPortSource,
} from "../src/application-port-source";

interface ExampleApplicationPort {
  execute(): Promise<void>;
}

type Assert<Condition extends true> = Condition;
type StaticPortIsAccepted = ExampleApplicationPort extends ApplicationPortSource<ExampleApplicationPort>
  ? true
  : false;
type RequestScopedResolverIsAccepted = ApplicationPortResolver<ExampleApplicationPort> extends ApplicationPortSource<ExampleApplicationPort>
  ? true
  : false;

export type DirectPortContract = Assert<StaticPortIsAccepted>;
export type RequestScopedPortContract = Assert<RequestScopedResolverIsAccepted>;
