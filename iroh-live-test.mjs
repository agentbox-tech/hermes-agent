import { createRequire } from 'node:module'
const req = createRequire(process.cwd() + '/probe.cjs')
const iroh = req('@number0/iroh/index.js')
const ep = await iroh.Endpoint.bind()
const conn = await ep.connect(iroh.EndpointTicket.fromString(process.argv[2]).endpointAddr(), Array.from(new TextEncoder().encode('hermes-http/0')))
const stream = await conn.openBi()
await stream.send.writeAll(Array.from(new TextEncoder().encode('GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: */*\r\nConnection: close\r\n\r\n')))
await stream.send.finish()
let body = ''
for (;;) {
  const chunk = await stream.recv.read(65536)
  if (!chunk || chunk.length === 0) break
  body += new TextDecoder().decode(chunk)
}
console.log('RESPONSE:', body.split('\r\n')[0], '|', body.length, 'bytes')
console.log('body head:', body.slice(body.indexOf('\r\n\r\n') + 4, body.indexOf('\r\n\r\n') + 120).replace(/\n/g, ' '))
process.exit(0)
