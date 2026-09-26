export async function onRequest(context) {
  return new Response("Страница функций работает отлично!", {
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}
