export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,PATCH,DELETE,PUT",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

export function errorHandler(err: unknown) {
  return Response.json((err as Error).message, {
    status: 500,
    headers: corsHeaders,
  });
}
