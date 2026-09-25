import { describe, expect, test } from "bun:test";
import { callSystemOne, listSystemOneModels } from "./systemone-client.js";
import {
  SystemOneRequestSchema,
  validateSystemOneResponse,
  type SystemOneRequest,
  type SystemOneResponse,
} from "./systemone-schema.js";

const request: SystemOneRequest = {
  state: { item: "red" },
  questions: {
    binary: { type: "noul", instructions: "Is it red?" },
    color: {
      type: "choice",
      instructions: "Color?",
      criteria: { red: null, blue: { description: "Blue" } },
    },
    rating: {
      type: "score",
      instructions: ["How red?"],
      criteria: ["Not red", "Red"],
    },
  },
};
const response = {
  model: "openjev-0.1",
  answers: {
    binary: { type: "noul", noul: 0.9 },
    color: {
      type: "choice",
      choice: "red",
      probabilities: { red: 0.9, blue: 0.1 },
      confidence: 0.8,
    },
    rating: {
      type: "score",
      score: 0.9,
      legend: { "0": "Not red", "1": "Red" },
      probabilities: { "0": 0.1, "1": 0.9 },
      confidence: 0.8,
    },
  },
  usage: { input_tokens: 30, output_tokens: 0 },
} satisfies SystemOneResponse;
const target = {
  endpoint: "https://provider.test/v1/systemone",
  apiKey: "secret",
  model: "EigenJev",
  questionTypes: ["noul", "choice", "score"],
};

// Real HTTP exercises abort propagation and transport without replacing global fetch.
function serving(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  return {
    endpoint: `${server.url}v1/systemone`,
    stop: () => server.stop(true),
  };
}

describe("SystemOne wire contract", () => {
  test("accepts all three types, structured content and fractional scores", () => {
    expect(SystemOneRequestSchema.parse(request)).toEqual(request);
    expect(validateSystemOneResponse(request, response)).toEqual(response);
  });
  test("rejects mismatched IDs, types, choices, probability sets and score ranges", () => {
    for (const answers of [
      { ...response.answers, extra: { type: "noul", noul: 0.5 } },
      { ...response.answers, binary: { type: "noul", noul: 1.2 } },
      { ...response.answers, binary: response.answers.color },
      {
        ...response.answers,
        color: { ...response.answers.color, choice: "green" },
      },
      {
        ...response.answers,
        color: { ...response.answers.color, probabilities: { red: 1 } },
      },
      {
        ...response.answers,
        color: {
          ...response.answers.color,
          probabilities: { red: 0.8, blue: 0.8 },
        },
      },
      { ...response.answers, rating: { ...response.answers.rating, score: 2 } },
    ])
      expect(() =>
        validateSystemOneResponse(request, { ...response, answers }),
      ).toThrow();
    expect(() =>
      validateSystemOneResponse(request, { ...response, answers: {} }),
    ).toThrow();
  });
  test("sends the requested alias with a Bearer key, preserving the resolved model and revision", async () => {
    const server = serving(async (req) => {
      expect(req.headers.get("authorization")).toBe("Bearer secret");
      expect(await req.json()).toEqual({ ...request, model: "EigenJev" });
      return Response.json(response);
    });
    try {
      expect(
        await callSystemOne(
          {
            ...target,
            endpoint: server.endpoint,
            deploymentRevision: "build-123",
          },
          request,
        ),
      ).toEqual({ ...response, deployment_revision: "build-123" });
    } finally {
      server.stop();
    }
  });
  test("retries overloads, respects Retry-After and bounds attempts", async () => {
    let calls = 0;
    const server = serving(() =>
      ++calls < 3
        ? new Response("busy", {
            status: calls === 1 ? 429 : 529,
            headers: { "retry-after": "0" },
          })
        : Response.json(response),
    );
    try {
      expect(
        (await callSystemOne({ ...target, endpoint: server.endpoint }, request))
          .model,
      ).toBe("openjev-0.1");
      expect(calls).toBe(3);
    } finally {
      server.stop();
    }
    calls = 0;
    const overloaded = serving(() => {
      calls++;
      return new Response("busy", { status: 529 });
    });
    try {
      await expect(
        callSystemOne({ ...target, endpoint: overloaded.endpoint }, request, {
          retryDelayMs: 1,
        }),
      ).rejects.toMatchObject({ code: "systemone_unavailable" });
      expect(calls).toBe(3);
    } finally {
      overloaded.stop();
    }
  });
  test("never retries auth errors or exposes the provider body", async () => {
    let calls = 0;
    const server = serving(() => {
      calls++;
      return new Response("secret document and key", { status: 401 });
    });
    try {
      await expect(
        callSystemOne({ ...target, endpoint: server.endpoint }, request),
      ).rejects.toMatchObject({ code: "systemone_authentication" });
      expect(calls).toBe(1);
    } finally {
      server.stop();
    }
  });
  test("rejects unsupported questions before sending and honors cancellation", async () => {
    let calls = 0;
    const server = serving(() => {
      calls++;
      return Response.json(response);
    });
    try {
      await expect(
        callSystemOne(
          { ...target, endpoint: server.endpoint, questionTypes: ["noul"] },
          request,
        ),
      ).rejects.toMatchObject({ status: 422 });
      const controller = new AbortController();
      controller.abort();
      await expect(
        callSystemOne({ ...target, endpoint: server.endpoint }, request, {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "systemone_cancelled" });
      expect(calls).toBe(0);
    } finally {
      server.stop();
    }
  });
  test("does not forward credentials through redirects or accept malformed success", async () => {
    let destinationCalls = 0;
    const destination = serving(() => {
      destinationCalls++;
      return Response.json(response);
    });
    const redirect = serving(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: destination.endpoint },
        }),
    );
    const malformed = serving(() =>
      Response.json({ model: "made-up", answers: {} }),
    );
    try {
      await expect(
        callSystemOne({ ...target, endpoint: redirect.endpoint }, request),
      ).rejects.toMatchObject({ code: "systemone_unavailable" });
      expect(destinationCalls).toBe(0);
      await expect(
        callSystemOne({ ...target, endpoint: malformed.endpoint }, request),
      ).rejects.toMatchObject({ code: "systemone_invalid_response" });
    } finally {
      redirect.stop();
      destination.stop();
      malformed.stop();
    }
  });
});

describe("SystemOne model discovery", () => {
  test("uses authenticated sibling GET models and the native TypeSafe model cards", async () => {
    const server = serving((req) => {
      expect(req.method).toBe("GET");
      expect(new URL(req.url).pathname).toBe("/v1/models");
      expect(req.headers.get("authorization")).toBe("Bearer secret");
      return Response.json({models:[{name:"jev-latest",description:"Stable",release_date:"2026-09-01"},{name:"jev-preview",description:"Preview",release_date:"2026-09-02"}]});
    });
    try {
      const models=await listSystemOneModels({...target,endpoint:server.endpoint});
      expect(models.map(m=>m.id)).toEqual(["jev-latest","jev-preview"]);
      expect(models[0]).toMatchObject({description:"Stable",releaseDate:"2026-09-01",questionTypes:["noul","choice","score"]});
    } finally {server.stop();}
  });
  test("rejects invalid catalogs and does not expose upstream error bodies", async () => {
    for (const payload of [{data:[{id:"chat-model"}]},{models:[{name:"missing-metadata"}]},{models:[{name:"jev",description:"x",release_date:"x"},{name:"jev",description:"x",release_date:"x"}]}]) {
      const server=serving(()=>Response.json(payload));
      try { await expect(listSystemOneModels({...target,endpoint:server.endpoint})).rejects.toMatchObject({code:"systemone_catalog_invalid"}); }
      finally {server.stop();}
    }
    const server=serving(()=>new Response("private upstream secret",{status:401}));
    try { await expect(listSystemOneModels({...target,endpoint:server.endpoint})).rejects.toMatchObject({status:401,message:"Could not load this provider's models (HTTP 401)."}); }
    finally {server.stop();}
  });
  test("never forwards discovery credentials to a redirect target",async()=>{
    let reached=false;
    const destination=serving(()=>{reached=true;return Response.json({models:[]});});
    const server=serving(()=>Response.redirect(destination.endpoint));
    try {
      await expect(listSystemOneModels({...target,endpoint:server.endpoint})).rejects.toMatchObject({code:"systemone_catalog_unavailable"});
      expect(reached).toBe(false);
    } finally {server.stop();destination.stop();}
  });
});
