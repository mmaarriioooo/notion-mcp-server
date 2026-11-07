import { describe, it, expect } from 'vitest'
import path from 'path'
import fs from 'fs'
import type { OpenAPIV3 } from 'openapi-types'
import type { JSONSchema7 as IJsonSchema } from 'json-schema'
import { deserializeParams } from '../deserialize'
import { OpenAPIToMCPConverter } from '../../openapi/parser'

describe('deserializeParams', () => {
  describe('without a schema (legacy behavior)', () => {
    it('decodes JSON-encoded objects and arrays', () => {
      expect(deserializeParams({ parent: '{"page_id":"abc"}', ids: '["a","b"]' })).toEqual({
        parent: { page_id: 'abc' },
        ids: ['a', 'b'],
      })
    })

    it('decodes double-encoded values', () => {
      const twice = JSON.stringify(JSON.stringify({ page_id: 'abc' }))
      expect(deserializeParams({ parent: twice })).toEqual({ parent: { page_id: 'abc' } })
    })

    it('leaves plain strings and scalar-looking strings alone', () => {
      expect(deserializeParams({ a: 'hello', b: '42', c: 'true', d: '{not json}' })).toEqual({
        a: 'hello',
        b: '42',
        c: 'true',
        d: '{not json}',
      })
    })
  })

  describe('with a schema', () => {
    const schema: IJsonSchema = {
      type: 'object',
      $defs: {
        richText: {
          type: 'object',
          properties: { text: { type: 'object', properties: { content: { type: 'string' } } } },
        },
      },
      properties: {
        title: { type: 'string' },
        parent: { anyOf: [{ type: 'object', properties: { page_id: { type: 'string' } } }, { type: 'string' }] },
        rich_text: { type: 'array', items: { $ref: '#/$defs/richText' } },
        anything: {},
      },
    }

    it('keeps JSON-looking text in fields the schema declares as strings', () => {
      expect(deserializeParams({ title: '[1, 2, 3]' }, schema)).toEqual({ title: '[1, 2, 3]' })
      expect(deserializeParams({ title: '{"name": "Mario"}' }, schema)).toEqual({ title: '{"name": "Mario"}' })
    })

    it('keeps JSON-looking text in nested string fields reached via $ref', () => {
      const args = { rich_text: [{ text: { content: '{"a": 1}' } }] }
      expect(deserializeParams(args, schema)).toEqual(args)
    })

    it('keeps nested string fields as text even when the parent object arrived stringified', () => {
      const args = { rich_text: JSON.stringify([{ text: { content: '[1, 2]' } }]) }
      // rich_text is an array type → decoded; content is a string → kept
      expect(deserializeParams(args, schema)).toEqual({ rich_text: [{ text: { content: '[1, 2]' } }] })
    })

    it('still decodes stringified values where the schema accepts an object', () => {
      expect(deserializeParams({ parent: '{"page_id":"abc"}' }, schema)).toEqual({ parent: { page_id: 'abc' } })
    })

    it('falls back to decoding where the schema has no type information', () => {
      expect(deserializeParams({ anything: '{"x":1}', unknown_key: '[1]' }, schema)).toEqual({
        anything: { x: 1 },
        unknown_key: [1],
      })
    })
  })

  describe('against the real Notion OpenAPI spec', () => {
    const spec = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'scripts/notion-openapi.json'), 'utf-8'),
    ) as OpenAPIV3.Document
    const { tools } = new OpenAPIToMCPConverter(spec).convertToMCPTools()
    const inputSchema = (name: string) =>
      Object.values(tools)
        .flatMap((t) => t.methods)
        .find((m) => m.name === name)!.inputSchema

    it('patch-block-children keeps paragraph text that looks like JSON', () => {
      const args = {
        block_id: 'abc',
        children: [
          {
            type: 'paragraph',
            paragraph: { rich_text: [{ type: 'text', text: { content: '[1, 2, 3]' } }] },
          },
          {
            type: 'paragraph',
            paragraph: { rich_text: [{ type: 'text', text: { content: '{"name": "Mario"}' } }] },
          },
        ],
      }
      expect(deserializeParams(args, inputSchema('patch-block-children'))).toEqual(args)
    })

    it('patch-block-children still decodes stringified children', () => {
      const children = [{ type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'hi' } }] } }]
      expect(
        deserializeParams({ block_id: 'abc', children: JSON.stringify(children) }, inputSchema('patch-block-children')),
      ).toEqual({ block_id: 'abc', children })
    })

    it('post-page still decodes a stringified parent', () => {
      expect(deserializeParams({ parent: '{"page_id":"abc"}' }, inputSchema('post-page'))).toEqual({
        parent: { page_id: 'abc' },
      })
    })
  })
})
