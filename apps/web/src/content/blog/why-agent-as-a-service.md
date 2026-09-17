---
title: "Why Agent as a Service"
description: "As AI agents take on more of the work themselves, scaling them requires a service. Why the local agent is a beginning, and what comes after the copilot."
publishedAt: 2026-09-12
updatedAt: 2026-09-12
author: openma
tags: ["agents", "agent-as-a-service", "scaling-agents", "local-agents", "future-of-work", "self-hosted"]
---

The local agent comes with an assumption so familiar that it is easy to
miss: there will be a person using it.

Someone opens the application, chooses the task, supplies the context, and
decides what to do with the answer. The agent may write most of the code or
prepare most of the report. The work still belongs to the person at the
keyboard.

That is a natural place to begin. A laptop already has files, tools, and
access to other systems. Its owner can fill in whatever the agent cannot
yet handle. Put a capable model there and it becomes useful quickly.

But the ambition of agents is larger than making that person faster.
As an agent becomes able to carry an assignment further on its own, the
person's involvement should become less necessary. Eventually, some work
should be assignable directly to the software, with a person brought in
only where judgment or authority is needed.

At that point, giving every person a better assistant begins to look like
an oddly small destination.

## There is a job between the prompts

Much of office work follows an unremarkable rhythm. Read something, check
it against a rule, update a record, ask for what is missing, wait, and
continue. The hard cases need judgment. The ordinary cases need someone
to keep going.

A supplier sends an incomplete set of documents. A copilot can help draft
the reply. The person remembers to follow up, notices when the missing
attachment arrives, checks it, and moves the packet to approval.

Now give the agent the whole case. It knows which documents are required,
what it may request, and when to ask for a decision. It receives the reply
and continues. The person who would once have carried the case sees it
again only if there is something the agent cannot resolve.

The amount of work has not changed. Who needs to spend the day attending
to it has.

This is the possibility worth pursuing across the white-collar market.
The same reading, checking, correspondence, and record-keeping appears in
many forms. Agents will earn their place one class of assignment at a time.
Each time they can finish one without continuous direction, a little more
work becomes something software can be given outright.

## A thousand agents, a thousand operators?

Once an agent can do useful work independently, the next question is how
to run many of them.

A thousand copies of a personal assistant are easy enough to imagine.
A thousand people choosing tasks, repairing context, and prompting those
assistants through the day would preserve much of the arrangement we
started with.

The point of scaling agents is to increase the work they carry through
without needing a corresponding amount of human attention. That gives us
a more demanding measure of progress than the number of concurrent sessions.
An agent that completes a case and takes the next one contributes something
different from an agent that keeps creating work for its operator.

Even a small dependence becomes expensive when repeated often enough.
An occasional request to restart a process becomes a stream of interruptions.
A habit of asking for context becomes a job supplying context. If a person
must decide every next step, adding agents mostly adds decisions to that
person's queue.

This is why the personal tool is a limiting product shape. It has a
convenient answer to almost every difficulty: return to the user. At scale,
we have to be much more selective about when that answer is acceptable.

## Agent as a service gives the work somewhere to live

A service can accept an assignment before a worker starts and retain it
after that worker stops. It can receive the next document, recover a failed
execution, and make the result available without keeping a client connected.
People can inspect it when they need to. Their presence is not what holds
the task together.

That is the reason for **agent as a service**. It is the form needed to
operate agents as the ones doing the work.

Consider what happens when a hundred agents are active. Some are waiting
for replies. Some need compute. Some are using the same external system.
One has failed halfway through an update. Another is ready to hand a result
to the next agent.

These situations need somewhere to be resolved. Waiting should not occupy
an expensive worker indefinitely. Restarting should not mean repeating an
action that already succeeded. Two agents should not unknowingly take the
same assignment. More available compute should let ready work proceed;
less compute should slow the queue without losing it.

The infrastructure is familiar in outline, but it matters enormously here.
Without it, someone becomes the scheduler, the memory, and the recovery
mechanism for a collection of supposedly autonomous workers.

A local agent can acquire persistent state, queues, scoped access, remote
workers, and recovery. As it does, it becomes a service. The terminal can
remain an interface. It no longer needs to be the center of the system.

## The future has fewer people in the loop for ordinary work

We expect agents to be given longer assignments as their reliability
improves. A request to summarize a document becomes a request to process
a case. Processing one case becomes a standing assignment to handle a
particular kind of incoming work.

The useful unit of scale is then completed work. How much can these agents
finish? How many cases need intervention? How much time does that
intervention take? Those questions tell us whether agents are becoming
independent workers or merely busier assistants.

There will still be decisions that belong to people. The important change
is that people need not sit in the path of every routine action. An agent
should arrive with the exceptional case, the evidence, and the decision
it needs. The ordinary cases should already be moving.

As this becomes practical, software will have more work assigned to it
directly. Agents will receive tasks from systems and other agents, carry
them across periods of waiting, and publish results for whoever needs them
next. Opening a chat will be one way to start work, rather than a condition
for work to happen.

We think much of the progress will look quiet. A category of requests stops
needing daily attention. A recurring report arrives without anyone preparing
it. Cases reach completion without passing through someone's personal
queue. The work is still there; increasingly, the agents are attending to it.

## Local execution has a place in that future

Some tasks need a particular device, private files, or close interaction
with a person. Local workers will remain useful for those tasks. A service
can also run entirely on infrastructure its owner controls.

The distinction that matters is whether every agent depends on a personal
operator. Where its compute runs is a separate choice. A machine under a
desk can execute work for a service just as a remote sandbox can.

This is the direction behind
[Open Managed Agents](https://github.com/openma-ai/open-managed-agents).
Durable sessions, managed execution, credentials, and persistent outputs
provide a foundation for agents that can keep working independently of
their clients. Our
[OpenAI Agents API support](/blog/openai-agents-api-self-hosted/) is another
way to build on that foundation. Reliable services for particular kinds
of work still need to be built and evaluated on top of it.

Local agents gave capable models a place beside the person doing the job.
Scaling agents means gradually removing the need for that seat beside them.
A service gives them somewhere to work when it is empty.
