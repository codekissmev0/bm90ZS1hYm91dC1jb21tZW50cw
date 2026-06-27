import fs from "node:fs/promises"

const marker = "codekissme-inline-comment:v1"
const outputPath = "inline-comments.json"

const repository = process.env.GITHUB_REPOSITORY
const token = process.env.GITHUB_TOKEN

if (!repository || !repository.includes("/")) {
  throw new Error("GITHUB_REPOSITORY must be set to owner/name")
}

if (!token) {
  throw new Error("GITHUB_TOKEN must be set")
}

const [owner, name] = repository.split("/")

async function graphql(query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "codekissme-inline-comments-manifest",
    },
    body: JSON.stringify({ query, variables }),
  })

  const payload = await response.json()
  if (!response.ok || payload.errors) {
    throw new Error(JSON.stringify(payload.errors ?? payload, null, 2))
  }

  return payload.data
}

async function fetchDiscussions() {
  const discussions = []
  let cursor = null

  do {
    const data = await graphql(
      `query InlineCommentDiscussions($owner: String!, $name: String!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          discussions(first: 100, after: $cursor, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              title
              body
              url
              number
              closed
              createdAt
              updatedAt
              category {
                name
              }
            }
          }
        }
      }`,
      { owner, name, cursor },
    )

    const connection = data.repository.discussions
    discussions.push(...connection.nodes)
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null
  } while (cursor)

  return discussions
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4)
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8")
}

function parseMetadataToken(tokenValue) {
  const trimmed = tokenValue.trim()
  if (!trimmed) return undefined

  try {
    return JSON.parse(trimmed.startsWith("{") ? trimmed : decodeBase64Url(trimmed))
  } catch {
    return undefined
  }
}

function parseInlineTerm(title) {
  const match = /^inline:(.+):(ic-[a-z0-9]+)$/i.exec(title)
  if (!match) return undefined
  return {
    pageTerm: match[1],
    id: match[2],
    term: title,
  }
}

function parseMetadata(body) {
  const entries = []
  const pattern = new RegExp(`<!--\\s*${marker}\\s+([\\s\\S]*?)\\s*-->`, "g")
  let match = pattern.exec(body ?? "")

  while (match) {
    const parsed = parseMetadataToken(match[1])
    if (parsed && typeof parsed === "object") {
      entries.push(parsed)
    }
    match = pattern.exec(body ?? "")
  }

  return entries
}

function stringValue(value) {
  return typeof value === "string" ? value : ""
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function dateValue(value) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeEntry(raw, discussion) {
  const fallback = parseInlineTerm(discussion.title)
  const pageTerm = stringValue(raw.pageTerm) || stringValue(raw.commentsId) || fallback?.pageTerm
  const id = stringValue(raw.id) || fallback?.id
  const exact = stringValue(raw.exact)

  if (!pageTerm || !id || !exact) return undefined

  return {
    id,
    term: stringValue(raw.term) || fallback?.term || `inline:${pageTerm}:${id}`,
    exact,
    prefix: stringValue(raw.prefix),
    suffix: stringValue(raw.suffix),
    blockId: stringValue(raw.blockId) || undefined,
    headingId: stringValue(raw.headingId) || undefined,
    blockTextHash: stringValue(raw.blockTextHash),
    pagePath: stringValue(raw.pagePath),
    createdAt: numberValue(raw.createdAt) ?? dateValue(discussion.createdAt) ?? 1,
    updatedAt: numberValue(raw.updatedAt) ?? dateValue(discussion.updatedAt),
    discussionUrl: discussion.url,
    discussionNumber: discussion.number,
  }
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

async function readPreviousManifest() {
  try {
    return JSON.parse(await fs.readFile(outputPath, "utf8"))
  } catch {
    return undefined
  }
}

const pages = new Map()

for (const discussion of await fetchDiscussions()) {
  if (discussion.closed) continue

  const fallback = parseInlineTerm(discussion.title)
  const entries = parseMetadata(discussion.body)

  for (const raw of entries) {
    const normalized = normalizeEntry(raw, discussion)
    if (!normalized) continue

    const pageTerm = stringValue(raw.pageTerm) || stringValue(raw.commentsId) || fallback?.pageTerm
    const page = pages.get(pageTerm) ?? []
    page.push(withoutUndefined(normalized))
    pages.set(pageTerm, page)
  }
}

const sortedPages = Object.fromEntries(
  [...pages.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pageTerm, entries]) => [
      pageTerm,
      entries.sort((a, b) => String(a.id).localeCompare(String(b.id))),
    ]),
)

const previous = await readPreviousManifest()
const previousPages = JSON.stringify(previous?.pages ?? {})
const nextPages = JSON.stringify(sortedPages)

const manifest =
  previous && previousPages === nextPages
    ? previous
    : {
        version: 1,
        generatedAt: new Date().toISOString(),
        pages: sortedPages,
      }

await fs.writeFile(`${outputPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`)
await fs.rename(`${outputPath}.tmp`, outputPath)
