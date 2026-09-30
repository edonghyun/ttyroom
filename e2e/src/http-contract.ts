import SwaggerParser from "@apidevtools/swagger-parser";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { OpenAPIV3_1 } from "openapi-types";
import { fileURLToPath } from "node:url";

export interface HttpObservation {
  status: number;
  headers: Headers;
  body: string;
}

type Operation = OpenAPIV3_1.OperationObject & {
  responses: Record<string, OpenAPIV3_1.ResponseObject>;
};

/** Test-only boundary: inspect real responses without logging credentials or response bodies. */
export class HttpContract {
  private readonly schemas = new Ajv2020({ allErrors: true, strict: true });
  private constructor(private readonly document: OpenAPIV3_1.Document) {}

  static async load(): Promise<HttpContract> {
    const document = await SwaggerParser.validate(
      fileURLToPath(new URL("../../protocol/openapi.json", import.meta.url)),
      { resolve: { external: false }, dereference: { circular: false } },
    );
    return new HttpContract(document as OpenAPIV3_1.Document);
  }

  private operations() {
    return Object.entries(this.document.paths ?? {}).flatMap(([path, item]) =>
      (["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const).flatMap(
        (method) => {
          const operation = item?.[method];
          return operation ? [{ path, method, operation: operation as Operation }] : [];
        },
      ),
    );
  }

  private operation(id: string): Operation {
    const found = this.operations().find(({ operation }) => operation.operationId === id);
    if (!found) throw new Error(`Undocumented HTTP operation: ${id}`);
    return found.operation;
  }

  requestExample(id: string): Record<string, unknown> {
    const request = this.operation(id).requestBody as OpenAPIV3_1.RequestBodyObject;
    const example = request.content["application/json"]?.examples
      ?.example as OpenAPIV3_1.ExampleObject;
    if (!example) throw new Error(`Missing request example: ${id}`);
    return structuredClone(example.value);
  }

  responseExample(id: string, status: number): unknown {
    const response = this.operation(id).responses[String(status)];
    const example = response?.content?.["application/json"]?.examples
      ?.example as OpenAPIV3_1.ExampleObject;
    if (!example) throw new Error(`Missing response example: ${id}/${status}`);
    return structuredClone(example.value);
  }

  exampleViolations(): string[] {
    const violations: string[] = [];
    for (const { operation } of this.operations()) {
      const id = operation.operationId!;
      const request = operation.requestBody as OpenAPIV3_1.RequestBodyObject | undefined;
      for (const media of Object.values(request?.content ?? {})) {
        for (const example of Object.values(media.examples ?? {})) {
          if (
            media.schema &&
            !this.schemas.validate(media.schema, (example as OpenAPIV3_1.ExampleObject).value)
          )
            violations.push(`Request example violates schema: ${id}`);
        }
      }
      for (const [status, response] of Object.entries(operation.responses)) {
        for (const [type, media] of Object.entries(response.content ?? {})) {
          for (const example of Object.values(media.examples ?? {})) {
            if (
              media.schema &&
              !this.schemas.validate(media.schema, (example as OpenAPIV3_1.ExampleObject).value)
            )
              violations.push(`Response example violates schema: ${id}/${status}/${type}`);
          }
        }
      }
    }
    return violations;
  }

  responseViolations(id: string, observed: HttpObservation): string[] {
    const response = this.operation(id).responses[String(observed.status)];
    if (!response) return [`Undocumented response status: ${observed.status}`];
    const violations: string[] = [];
    for (const [name, definition] of Object.entries(response.headers ?? {})) {
      const header = definition as OpenAPIV3_1.HeaderObject;
      const value = observed.headers.get(name);
      if (value === null) {
        if (header.required) violations.push(`Missing response header: ${name}`);
      } else if (header.schema && !this.schemas.validate(header.schema, value)) {
        violations.push(`Response header violates schema: ${name}`);
      }
    }
    if (!response.content) {
      if (observed.body !== "") violations.push("Expected empty response body");
      return violations;
    }
    const type = observed.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const media = type ? response.content[type] : undefined;
    if (!media?.schema) return [...violations, "Undocumented response content type"];
    let body: unknown = observed.body;
    if (type === "application/json") {
      try {
        body = JSON.parse(observed.body);
      } catch {
        return [...violations, "Invalid JSON response"];
      }
    }
    if (!this.schemas.validate(media.schema, body))
      violations.push("Response body violates schema");
    return violations;
  }
}
