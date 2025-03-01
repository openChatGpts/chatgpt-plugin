import Keyv from 'keyv'
import pTimeout from 'p-timeout'
import QuickLRU from 'quick-lru'
import { v4 as uuidv4 } from 'uuid'

import * as tokenizer from './tokenizer'
import * as types from './types'
import globalFetch from 'node-fetch'
import { fetchSSE } from './fetch-sse'
import {openai, Role} from "./types";

const CHATGPT_MODEL = 'gpt-4o-mini'

const USER_LABEL_DEFAULT = 'User'
const ASSISTANT_LABEL_DEFAULT = 'ChatGPT'

export class ChatGPTAPI {
    protected _apiKey: string
    protected _apiBaseUrl: string
    protected _apiOrg?: string
    protected _debug: boolean

    protected _systemMessage: string
    protected _completionParams: Omit<
        types.openai.CreateChatCompletionRequest,
        'messages' | 'n'
        >
    protected _maxModelTokens: number
    protected _maxResponseTokens: number
    protected _fetch: types.FetchFn

    protected _getMessageById: types.GetMessageByIdFunction
    protected _upsertMessage: types.UpsertMessageFunction

    protected _messageStore: Keyv<types.ChatMessage>

    /**
     * Creates a new client wrapper around OpenAI's chat completion API, mimicing the official ChatGPT webapp's functionality as closely as possible.
     *
     * @param apiKey - OpenAI API key (required).
     * @param apiOrg - Optional OpenAI API organization (optional).
     * @param apiBaseUrl - Optional override for the OpenAI API base URL.
     * @param debug - Optional enables logging debugging info to stdout.
     * @param completionParams - Param overrides to send to the [OpenAI chat completion API](https://platform.openai.com/docs/api-reference/chat/create). Options like `temperature` and `presence_penalty` can be tweaked to change the personality of the assistant.
     * @param maxModelTokens - Optional override for the maximum number of tokens allowed by the model's context. Defaults to 4096.
     * @param maxResponseTokens - Optional override for the minimum number of tokens allowed for the model's response. Defaults to 1000.
     * @param messageStore - Optional [Keyv](https://github.com/jaredwray/keyv) store to persist chat messages to. If not provided, messages will be lost when the process exits.
     * @param getMessageById - Optional function to retrieve a message by its ID. If not provided, the default implementation will be used (using an in-memory `messageStore`).
     * @param upsertMessage - Optional function to insert or update a message. If not provided, the default implementation will be used (using an in-memory `messageStore`).
     * @param fetch - Optional override for the `fetch` implementation to use. Defaults to the global `fetch` function.
     */
    constructor(opts: types.ChatGPTAPIOptions) {
        const {
            apiKey,
            apiOrg,
            apiBaseUrl = 'https://api.openai.com/v1',
            debug = false,
            messageStore,
            completionParams,
            systemMessage,
            maxModelTokens = 4000,
            maxResponseTokens = 1000,
            getMessageById,
            upsertMessage,
            fetch = globalFetch
        } = opts

        this._apiKey = apiKey
        this._apiOrg = apiOrg
        this._apiBaseUrl = apiBaseUrl
        this._debug = !!debug
        this._fetch = fetch

        this._completionParams = {
            model: CHATGPT_MODEL,
            temperature: 0.8,
            top_p: 1.0,
            presence_penalty: 1.0,
            ...completionParams
        }

        this._systemMessage = systemMessage

        if (this._systemMessage === undefined) {
            const currentDate = new Date().toISOString().split('T')[0]
            this._systemMessage = `You are ChatGPT, a large language model trained by OpenAI. Answer as concisely as possible.\nKnowledge cutoff: 2021-09-01\nCurrent date: ${currentDate}`
        }

        this._maxModelTokens = maxModelTokens
        this._maxResponseTokens = maxResponseTokens

        this._getMessageById = getMessageById ?? this._defaultGetMessageById
        this._upsertMessage = upsertMessage ?? this._defaultUpsertMessage

        if (messageStore) {
            this._messageStore = messageStore
        } else {
            this._messageStore = new Keyv<types.ChatMessage, any>({
                store: new QuickLRU<string, types.ChatMessage>({ maxSize: 10000 })
            })
        }

        if (!this._apiKey) {
            throw new Error('OpenAI missing required apiKey')
        }

        if (!this._fetch) {
            throw new Error('Invalid environment; fetch is not defined')
        }

        if (typeof this._fetch !== 'function') {
            throw new Error('Invalid "fetch" is not a function')
        }
    }

    /**
     * Sends a message to the OpenAI chat completions endpoint, waits for the response
     * to resolve, and returns the response.
     *
     * If you want your response to have historical context, you must provide a valid `parentMessageId`.
     *
     * If you want to receive a stream of partial responses, use `opts.onProgress`.
     *
     * Set `debug: true` in the `ChatGPTAPI` constructor to log more info on the full prompt sent to the OpenAI chat completions API. You can override the `systemMessage` in `opts` to customize the assistant's instructions.
     *
     * @param message - The prompt message to send
     * @param opts.parentMessageId - Optional ID of the previous message in the conversation (defaults to `undefined`)
     * @param opts.conversationId - Optional ID of the conversation (defaults to `undefined`)
     * @param opts.messageId - Optional ID of the message to send (defaults to a random UUID)
     * @param opts.systemMessage - Optional override for the chat "system message" which acts as instructions to the model (defaults to the ChatGPT system message)
     * @param opts.timeoutMs - Optional timeout in milliseconds (defaults to no timeout)
     * @param opts.onProgress - Optional callback which will be invoked every time the partial response is updated
     * @param opts.abortSignal - Optional callback used to abort the underlying `fetch` call using an [AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
     * @param completionParams - Optional overrides to send to the [OpenAI chat completion API](https://platform.openai.com/docs/api-reference/chat/create). Options like `temperature` and `presence_penalty` can be tweaked to change the personality of the assistant.
     *
     * @returns The response from ChatGPT
     */
    async sendMessage(
        text: string,
        opts: types.SendMessageOptions = {},
        role: Role = 'user',
    ): Promise<types.ChatMessage> {
        const {
            parentMessageId,
            messageId = uuidv4(),
            timeoutMs,
            onProgress,
            stream = onProgress ? true : false,
            completionParams,
            conversationId
        } = opts

        let { abortSignal } = opts

        let abortController: AbortController = null
        if (timeoutMs && !abortSignal) {
            abortController = new AbortController()
            abortSignal = abortController.signal
        }

        const message: types.ChatMessage = {
            role,
            id: messageId,
            conversationId,
            parentMessageId,
            text,
            name: opts.name
        }

        const latestQuestion = message

        const { messages, maxTokens, numTokens } = await this._buildMessages(
            text,
            role,
            opts,
            completionParams
        )
        console.log(`maxTokens: ${maxTokens}, numTokens: ${numTokens}`)
        const result: types.ChatMessage & { conversation: openai.ChatCompletionRequestMessage[] } = {
            role: 'assistant',
            id: uuidv4(),
            conversationId,
            parentMessageId: messageId,
            text: '',
            functionCall: undefined,
            toolCalls: undefined,
            conversation: []
        }

        const responseP = new Promise<types.ChatMessage & { conversation: openai.ChatCompletionRequestMessage[] }>(
            async (resolve, reject) => {
                const url = `${this._apiBaseUrl}/chat/completions`
                const headers = {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this._apiKey}`
                }
                const body = {
                    max_tokens: maxTokens,
                    ...this._completionParams,
                    ...completionParams,
                    messages,
                    stream
                }
                if (this._debug) {
                    console.log(JSON.stringify(body))
                }
                // Support multiple organizations
                // See https://platform.openai.com/docs/api-reference/authentication
                if (this._apiOrg) {
                    headers['OpenAI-Organization'] = this._apiOrg
                }

                if (this._debug) {
                    console.log(`sendMessage (${numTokens} tokens)`, body)
                }

                if (stream) {
                    fetchSSE(
                        url,
                        {
                            method: 'POST',
                            headers,
                            body: JSON.stringify(body),
                            signal: abortSignal,
                            onMessage: (data: string) => {
                                if (data === '[DONE]') {
                                    result.text = result.text.trim()
                                    result.conversation = messages
                                    return resolve(result)
                                }

                                try {
                                    const response: types.openai.CreateChatCompletionDeltaResponse =
                                        JSON.parse(data)

                                    if (response.id) {
                                        result.id = response.id
                                    }

                                    if (response.choices?.length) {
                                        const delta = response.choices[0].delta
                                        if (delta.function_call) {
                                            if (delta.function_call.name) {
                                                result.functionCall = {
                                                    name: delta.function_call.name,
                                                    arguments: delta.function_call.arguments
                                                }
                                            } else {
                                                result.functionCall.arguments = (result.functionCall.arguments || '') + delta.function_call.arguments
                                            }
                                        } else if (delta.tool_calls) {
                                          let fc = delta.tool_calls[0].function
                                          if (fc.name) {
                                            result.functionCall = {
                                              name: fc.name,
                                              arguments: fc.arguments
                                            }
                                          } else {
                                            result.functionCall.arguments = (result.functionCall.arguments || '') + fc.arguments
                                          }
                                        } else {
                                            result.delta = delta.content
                                            if (delta?.content) result.text += delta.content
                                        }
                                        if (delta.role) {
                                            result.role = delta.role
                                        }
                                        result.detail = response
                                        onProgress?.(result)
                                    }
                                } catch (err) {
                                    console.warn('OpenAI stream SEE event unexpected error', err)
                                    return reject(err)
                                }
                            }
                        },
                        this._fetch
                    ).catch(reject)
                } else {
                    try {
                        const res = await this._fetch(url, {
                            method: 'POST',
                            headers,
                            body: JSON.stringify(body),
                            signal: abortSignal
                        })

                        if (!res.ok) {
                            const reason = await res.text()
                            const msg = `OpenAI error ${
                                res.status || res.statusText
                            }: ${reason}`
                            const error = new types.ChatGPTError(msg, { cause: res })
                            error.statusCode = res.status
                            error.statusText = res.statusText
                            return reject(error)
                        }

                        const response: types.openai.CreateChatCompletionResponse =
                            await res.json()
                        if (this._debug) {
                            console.log(response)
                        }

                        if (response?.id) {
                            result.id = response.id
                        }

                        if (response?.choices?.length) {
                            const message = response.choices[0].message
                            if (message.content) {
                                result.text = message.content
                            } else if (message.function_call) {
                                result.functionCall = message.function_call
                            } else if (message.tool_calls) {
                                result.functionCall = message.tool_calls.map(tool => tool.function)[0]
                            }
                            if (message.role) {
                                result.role = message.role
                            }
                        } else {
                            const res = response as any
                            console.error(res)
                            return reject(
                                new Error(
                                    `OpenAI error: ${
                                        res?.detail?.message || res?.detail || 'unknown'
                                    }`
                                )
                            )
                        }

                        result.detail = response
                        result.conversation = messages
                        return resolve(result)
                    } catch (err) {
                        return reject(err)
                    }
                }
            }
        ).then(async (message) => {
            if (message.detail && !message.detail.usage) {
                try {
                    const promptTokens = numTokens
                    const completionTokens = await this._getTokenCount(message.text)
                    message.detail.usage = {
                        prompt_tokens: promptTokens,
                        completion_tokens: completionTokens,
                        total_tokens: promptTokens + completionTokens,
                        estimated: true
                    }
                } catch (err) {
                    // TODO: this should really never happen, but if it does,
                    // we should handle notify the user gracefully
                }
            }

            return Promise.all([
                this._upsertMessage(latestQuestion),
                this._upsertMessage(message)
            ]).then(() => message)
        })

        if (timeoutMs) {
            if (abortController) {
                // This will be called when a timeout occurs in order for us to forcibly
                // ensure that the underlying HTTP request is aborted.
                ;(responseP as any).cancel = () => {
                    abortController.abort()
                }
            }

            return pTimeout(responseP, {
                milliseconds: timeoutMs,
                message: 'OpenAI timed out waiting for response'
            })
        } else {
            return responseP
        }
    }

    get apiKey(): string {
        return this._apiKey
    }

    set apiKey(apiKey: string) {
        this._apiKey = apiKey
    }

    get apiOrg(): string {
        return this._apiOrg
    }

    set apiOrg(apiOrg: string) {
        this._apiOrg = apiOrg
    }

    protected async _buildMessages(text: string, role: Role, opts: types.SendMessageOptions, completionParams: Partial<
        Omit<openai.CreateChatCompletionRequest, 'messages' | 'n' | 'stream'>
    >) {
        const { systemMessage = this._systemMessage } = opts
        let { parentMessageId } = opts

        const userLabel = USER_LABEL_DEFAULT
        const assistantLabel = ASSISTANT_LABEL_DEFAULT

        const maxNumTokens = this._maxModelTokens - this._maxResponseTokens
        let messages: types.openai.ChatCompletionRequestMessage[] = []

        if (systemMessage) {
            messages.push({
                role: 'system',
                content: systemMessage
            })
        }

        const systemMessageOffset = messages.length
        let nextMessages = text
            ? messages.concat([
                {
                    role,
                    content: text,
                    name: opts.name
                }
            ])
            : messages

        let functionToken = 0

        let numTokens = functionToken
        // deprecated function call token calculation due to low efficiency
        // if (completionParams.functions) {
        //     for (const func of completionParams.functions) {
        //         functionToken += await this._getTokenCount(func?.name)
        //         functionToken += await this._getTokenCount(func?.description)
        //         if (func?.parameters?.properties) {
        //             for (let key of Object.keys(func.parameters.properties)) {
        //                 functionToken += await this._getTokenCount(key)
        //                 let property = func.parameters.properties[key]
        //                 for (let field of Object.keys(property)) {
        //                     switch (field) {
        //                         case 'type': {
        //                             functionToken += 2
        //                             functionToken += await this._getTokenCount(property?.type)
        //                             break
        //                         }
        //                         case 'description': {
        //                             functionToken += 2
        //                             functionToken += await this._getTokenCount(property?.description)
        //                             break
        //                         }
        //                         case 'enum': {
        //                             functionToken -= 3
        //                             for (let enumElement of property?.enum) {
        //                                 functionToken += 3
        //                                 functionToken += await this._getTokenCount(enumElement)
        //                             }
        //                             break
        //                         }
        //                     }
        //                 }
        //             }
        //         }
        //         if (func?.parameters?.required) {
        //             for (let string of func.parameters.required) {
        //                 functionToken += 2
        //                 functionToken += await this._getTokenCount(string)
        //             }
        //         }
        //     }
        // }

        do {
            const prompt = nextMessages
                .reduce((prompt, message) => {
                    switch (message.role) {
                        case 'system':
                            return prompt.concat([`Instructions:\n${message.content}`])
                        case 'user':
                            return prompt.concat([`${userLabel}:\n${message.content}`])
                        case 'function':
                            // leave behind
                            return prompt
                        case 'assistant':
                            return prompt
                        default:
                            return message.content ? prompt.concat([`${assistantLabel}:\n${message.content}`]) : prompt
                    }
                }, [] as string[])
                .join('\n\n')

            let nextNumTokensEstimate = await this._getTokenCount(prompt)

            for (const m1 of nextMessages
                .filter(m => m.function_call)) {
                nextNumTokensEstimate += await this._getTokenCount(JSON.stringify(m1.function_call) || '')
            }

            const isValidPrompt = nextNumTokensEstimate + functionToken <= maxNumTokens

            if (prompt && !isValidPrompt) {
                break
            }
            messages = nextMessages
            numTokens = nextNumTokensEstimate + functionToken

            if (!isValidPrompt) {
                break
            }

            if (!parentMessageId) {
                break
            }

            const parentMessage = await this._getMessageById(parentMessageId)
            if (!parentMessage) {
                break
            }

            const parentMessageRole = parentMessage.role || 'user'

            nextMessages = nextMessages.slice(0, systemMessageOffset).concat([
                {
                    role: parentMessageRole,
                    content: parentMessage.text,
                    name: parentMessage.name,
                    function_call: parentMessage.functionCall ? parentMessage.functionCall : undefined,
                    tools: parentMessage.toolCalls ? parentMessage.toolCalls : undefined
                },
                ...nextMessages.slice(systemMessageOffset)
            ])

            parentMessageId = parentMessage.parentMessageId
        } while (true)

        // Use up to 4096 tokens (prompt + response), but try to leave 1000 tokens
        // for the response.
        const maxTokens = Math.max(
            1,
            Math.min(this._maxModelTokens - numTokens, this._maxResponseTokens)
        )

        return { messages, maxTokens, numTokens }
    }

    protected async _getTokenCount(text: string) {
        if (!text) {
            return 0
        }
        // TODO: use a better fix in the tokenizer
        text = text.replace(/<\|endoftext\|>/g, '')

        return tokenizer.encode(text).length
    }

    protected async _defaultGetMessageById(
        id: string
    ): Promise<types.ChatMessage> {
        const res = await this._messageStore.get(id)
        return res
    }

    protected async _defaultUpsertMessage(
        message: types.ChatMessage
    ): Promise<void> {
        await this._messageStore.set(message.id, message)
    }
}
