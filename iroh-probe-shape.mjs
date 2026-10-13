import { createRequire } from 'node:module'
const req = createRequire(process.cwd() + '/probe.cjs')
const iroh = req('@number0/iroh/index.js')
const ep = await iroh.Endpoint.bind()
const conn = await ep.connect(iroh.EndpointTicket.fromString(process.argv[2]).endpointAddr(), Array.from(new TextEncoder().encode('hermes-http/0')))
const stream = await conn.openBi()
await stream.send.writeAll(Array.from(new TextEncoder().encode('GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')))
let total = []
for (let i = 0; i < 6; i++) {
  await new Promise(r => setTimeout(r, 1000))
  const chunk = await stream.recv.read(65536)
  if (chunk && chunk.length) { total = total.concat(chunk); console.log('chunk', i, '->', chunk.length, 'bytes') }
  if (!chunk || chunk.length === 0) break
}
console.log('TOTAL:', total.length, '| head:', Buffer.from(total).toString('utf8').split('\r\n')[0])
process.exit(0)
