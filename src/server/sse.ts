import type { Response } from 'express'

export type SseClient = {
  id: string
  res: Response
}

const clients: SseClient[] = []

export function addClient(res: Response) {
  const id = crypto.randomUUID()
  clients.push({ id, res })
  return id
}

export function removeClient(id: string) {
  const idx = clients.findIndex(c => c.id === id)
  if (idx >= 0) clients.splice(idx, 1)
}

export function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const c of clients) c.res.write(payload)
}