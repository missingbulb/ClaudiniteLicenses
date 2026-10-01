export default {
  async fetch(_request: Request, _env: unknown, _ctx: ExecutionContext): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
};
