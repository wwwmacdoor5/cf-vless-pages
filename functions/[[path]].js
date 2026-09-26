import { connect } from 'cloudflare:sockets';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const userID = env.UUID || "df6d58c3-370d-4253-a20e-b55c3a463a19";

  // 1. Запрос по вашему UUID — отдаем конфигурацию VLESS
  if (url.pathname === `/${userID}` || url.pathname === `/${userID}/`) {
    const host = request.headers.get('Host') || url.hostname;
    const vlessLink = `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F#CF-Pages-VLESS`;
    
    return new Response(
      `==================================================\n` +
      `ВАШ VLESS КОНФИГ ДЛЯ КЛИЕНТА (v2rayNG / NekoBox):\n` +
      `==================================================\n\n` +
      `${vlessLink}\n\n` +
      `--------------------------------------------------\n` +
      `Скопируйте строку выше (начинается с vless://) и вставьте из буфера обмена в приложение.`,
      {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      }
    );
  }

  // 2. Если это WebSocket запрос (само VPN-подключение)
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
    // Вызов обработчика WebSocket соединения
    return await handleVlessWS(request, userID);
  }

  // 3. Главная страница или любой другой путь
  return new Response("VLESS Pages Node is Active", { status: 200 });
}

async function handleVlessWS(request, userID) {
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();

  // Логика VLESS over WebSocket
  let remoteSocket = null;
  server.addEventListener('message', async (event) => {
    try {
      if (remoteSocket) {
        const writer = remoteSocket.writable.getWriter();
        await writer.write(new Uint8Array(event.data));
        writer.releaseLock();
        return;
      }

      const buffer = new Uint8Array(event.data);
      if (buffer.length < 24) return;

      // Проверка UUID (24 байта VLESS заголовка)
      const reqUUID = stringifyUUID(buffer.slice(1, 17));
      if (reqUUID !== userID.toLowerCase().replace(/-/g, '')) {
        server.close();
        return;
      }

      const port = (buffer[18] << 8) | buffer[19];
      const addressType = buffer[20];
      let address = '';
      let addressEnd = 21;

      if (addressType === 1) { // IPv4
        address = buffer.slice(21, 25).join('.');
        addressEnd = 25;
      } else if (addressType === 2) { // Domain
        const domainLen = buffer[21];
        address = new TextDecoder().decode(buffer.slice(22, 22 + domainLen));
        addressEnd = 22 + domainLen;
      } else if (addressType === 3) { // IPv6
        address = Array.from(buffer.slice(21, 37))
          .map((b, i) => (i % 2 === 0 ? ((b << 8) | buffer[21 + i + 1]).toString(16) : null))
          .filter(Boolean)
          .join(':');
        addressEnd = 37;
      }

      // Ответ VLESS (Response Header)
      server.send(new Uint8Array([buffer[0], 0]));

      // Устанавливаем прямое TCP соединение через cloudflare:sockets
      remoteSocket = connect({ hostname: address, port: port });
      const writer = remoteSocket.writable.getWriter();
      writer.write(buffer.slice(addressEnd));
      writer.releaseLock();

      remoteSocket.readable.pipeTo(new WritableStream({
        write(chunk) {
          if (server.readyState === 1) server.send(chunk);
        },
        close() { server.close(); },
        error() { server.close(); }
      }));

    } catch (err) {
      server.close();
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}

function stringifyUUID(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
