import { RpcAsyncGenerator, RpcStub, RpcTarget, type RpcConsumeOptions } from "../src/index.js"
import { expectAssignable, expectType } from "./helpers.js"

interface GeneratorApi {
  numbers(): AsyncGenerator<number, string, number>
  consume(gen: AsyncGenerator<number, string, unknown>): Promise<number[]>
}

declare const api: RpcStub<GeneratorApi>

const gen = api.numbers()
expectAssignable<Promise<AsyncGenerator<number, string, number>>>(gen)

async function assertTypes() {
  const resolved = await gen
  expectType<RpcAsyncGenerator<number, string, number>>(resolved)

  const same = resolved.consume({ maxBufferedItems: 32, minBufferedItems: 8, refillItems: 16 })
  expectType<RpcAsyncGenerator<number, string, number>>(same)

  const strict = resolved.consume({ maxBufferedItems: 1, minBufferedItems: 0, refillItems: 1 })
  expectType<RpcAsyncGenerator<number, string, number>>(strict)

  const first = await resolved.next()
  expectType<IteratorResult<number, string>>(first)

  await api.consume(resolved)
}

void assertTypes

const opts: RpcConsumeOptions = { maxBufferedItems: 16, minBufferedItems: 4, refillItems: 8 }
void opts

// @ts-expect-error maxBufferedItems must be numeric
api.numbers().consume({ maxBufferedItems: "nope" })

// @ts-expect-error minBufferedItems must be numeric
api.numbers().consume({ minBufferedItems: "nope" })

// @ts-expect-error refillItems must be numeric
api.numbers().consume({ refillItems: "nope" })
