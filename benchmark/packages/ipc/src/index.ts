import EventEmitter from "node:events"
import { Socket } from "node:net"
import * as crypto from "node:crypto"

import ipc from "node-ipc"
import { z } from "zod"

import { TaskCommand, taskCommandSchema, TaskEvent, taskEventSchema } from "@benchmark/types"

/**
 * IpcMessage
 */

export enum IpcMessageType {
	Ack = "Ack",
	TaskCommand = "TaskCommand",
	TaskEvent = "TaskEvent",
}

export enum IpcOrigin {
	Client = "client",
	Server = "server",
	Relay = "relay",
}

export const ipcMessageSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal(IpcMessageType.Ack),
		origin: z.literal(IpcOrigin.Server),
		data: z.object({ clientId: z.string() }),
	}),
	z.object({
		type: z.literal(IpcMessageType.TaskCommand),
		origin: z.literal(IpcOrigin.Client),
		clientId: z.string(),
		data: taskCommandSchema,
	}),
	z.object({
		type: z.literal(IpcMessageType.TaskEvent),
		origin: z.union([z.literal(IpcOrigin.Server), z.literal(IpcOrigin.Relay)]),
		relayClientId: z.string().optional(),
		data: taskEventSchema,
	}),
])

export type IpcMessage = z.infer<typeof ipcMessageSchema>

/**
 * IpcClient
 */

type IpcClientEvents = {
	connect: []
	disconnect: []
	ack: [clientId: string]
	taskCommand: [data: TaskCommand]
	taskEvent: [data: TaskEvent]
}

export class IpcClient extends EventEmitter<IpcClientEvents> {
	private readonly _socketPath: string
	private readonly _log: (...args: unknown[]) => void

	private _isConnected = false
	private _clientId?: string

	constructor(socketPath: string, log = console.log) {
		super()

		this._socketPath = socketPath
		this._log = log

		ipc.config.silent = true

		ipc.connectTo("benchmarkServer", this.socketPath, () => {
			ipc.of.benchmarkServer?.on("connect", (args) => this.onConnect(args))
			ipc.of.benchmarkServer?.on("disconnect", (args) => this.onDisconnect(args))
			ipc.of.benchmarkServer?.on("message", (data) => this.onMessage(data))
		})
	}

	private onConnect(args: unknown) {
		if (this._isConnected) {
			return
		}

		this.log("[client#onConnect]", args)
		this._isConnected = true
		this.emit("connect")
	}

	private onDisconnect(args: unknown) {
		if (!this._isConnected) {
			return
		}

		this.log("[client#onDisconnect]", args)
		this._isConnected = false
		this.emit("disconnect")
	}

	private onMessage(data: unknown) {
		if (typeof data !== "object") {
			this._log("[client#onMessage] invalid data", data)
			return
		}

		const result = ipcMessageSchema.safeParse(data)

		if (!result.success) {
			this.log("[client#onMessage] invalid payload", result.error)
			return
		}

		const payload = result.data

		if (payload.origin === IpcOrigin.Server) {
			switch (payload.type) {
				case IpcMessageType.Ack:
					this._clientId = payload.data.clientId
					this.emit("ack", payload.data.clientId)
					break
				case IpcMessageType.TaskEvent:
					this.emit("taskEvent", payload.data)
					break
			}
		}
	}

	private log(...args: unknown[]) {
		this._log(...args)
	}

	public sendMessage(message: IpcMessage) {
		ipc.of.benchmarkServer?.emit("message", message)
	}

	public disconnect() {
		try {
			ipc.disconnect("benchmarkServer")
			// @TODO: Should we set _disconnect here?
		} catch (error) {
			this.log("[client#disconnect] error disconnecting", error)
		}
	}

	public get socketPath() {
		return this._socketPath
	}

	public get clientId() {
		return this._clientId
	}

	public get isConnected() {
		return this._isConnected
	}

	public get isReady() {
		return this._isConnected && this._clientId !== undefined
	}
}

/**
 * IpcServer
 */

type IpcServerEvents = {
	connect: [clientId: string]
	disconnect: [clientId: string]
	taskCommand: [clientId: string, data: TaskCommand]
	taskEvent: [relayClientId: string | undefined, data: TaskEvent]
}

export class IpcServer extends EventEmitter<IpcServerEvents> {
	private readonly _socketPath: string
	private readonly _log: (...args: unknown[]) => void
	private readonly _clients: Map<string, Socket>

	private _isListening = false

	constructor(socketPath: string, log = console.log) {
		super()

		this._socketPath = socketPath
		this._log = log
		this._clients = new Map()
	}

	public listen() {
		this._isListening = true

		ipc.config.silent = true

		ipc.serve(this.socketPath, () => {
			ipc.server.on("connect", (socket) => this.onConnect(socket))
			ipc.server.on("socket.disconnected", (socket) => this.onDisconnect(socket))
			ipc.server.on("message", (data) => this.onMessage(data))
		})

		ipc.server.start()
	}

	private onConnect(socket: Socket) {
		const clientId = crypto.randomBytes(6).toString("hex")
		this._clients.set(clientId, socket)
		this.log(`[server#onConnect] clientId = ${clientId}, # clients = ${this._clients.size}`)
		this.send(socket, { type: IpcMessageType.Ack, origin: IpcOrigin.Server, data: { clientId } })
		this.emit("connect", clientId)
	}

	private onDisconnect(destroyedSocket: Socket) {
		let disconnectedClientId: string | undefined

		for (const [clientId, socket] of this._clients.entries()) {
			if (socket === destroyedSocket) {
				disconnectedClientId = clientId
				this._clients.delete(clientId)
				break
			}
		}

		this.log(`[server#socket.disconnected] clientId = ${disconnectedClientId}, # clients = ${this._clients.size}`)

		if (disconnectedClientId) {
			this.emit("disconnect", disconnectedClientId)
		}
	}

	private onMessage(data: unknown) {
		if (typeof data !== "object") {
			this.log("[server#onMessage] invalid data", data)
			return
		}

		const result = ipcMessageSchema.safeParse(data)

		if (!result.success) {
			this.log("[server#onMessage] invalid payload", result.error)
			return
		}

		const payload = result.data

		if (payload.origin === IpcOrigin.Client) {
			switch (payload.type) {
				case IpcMessageType.TaskCommand:
					this.emit("taskCommand", payload.clientId, payload.data)
					break
			}
		} else if (payload.origin === IpcOrigin.Relay) {
			switch (payload.type) {
				case IpcMessageType.TaskEvent:
					this.emit("taskEvent", payload.relayClientId, payload.data)
					break
			}
		}
	}

	private log(...args: unknown[]) {
		this._log(...args)
	}

	public broadcast(message: IpcMessage) {
		this.log("[server#broadcast] message =", message)
		ipc.server.broadcast("message", message)
	}

	public send(client: string | Socket, message: IpcMessage) {
		this.log("[server#send] message =", message)

		if (typeof client === "string") {
			const socket = this._clients.get(client)

			if (socket) {
				ipc.server.emit(socket, "message", message)
			}
		} else {
			ipc.server.emit(client, "message", message)
		}
	}

	public get socketPath() {
		return this._socketPath
	}

	public get isListening() {
		return this._isListening
	}
}
