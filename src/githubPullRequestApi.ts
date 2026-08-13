import * as https from 'https';
import type { IncomingHttpHeaders } from 'http';

/** Git remote 이름과 GitHub 저장소 식별자를 함께 보관한다. */
export interface GithubRemote {
  readonly remoteName: string;
  readonly owner: string;
  readonly repo: string;
}

/** 댓글과 변경 파일을 읽을 PR의 최소 식별 정보다. */
export interface PullRequestSummary {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/** 현재 branch PR을 찾는 데 필요한 base/head remote 후보와 branch 이름이다. */
export interface PullRequestLookupInput {
  readonly branchName: string;
  readonly baseRemotes: readonly GithubRemote[];
  readonly headRemotes: readonly GithubRemote[];
}

/** 테스트에서 GitHub 응답을 주입할 수 있도록 분리한 JSON 요청 옵션이다. */
export interface GithubJsonRequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly body?: string;
}

/** GitHub JSON 응답과 pagination header를 함께 반환한다. */
export interface GithubJsonResponse<T> {
  readonly value: T;
  readonly headers: IncomingHttpHeaders;
}

/** 실제 HTTPS 요청과 테스트 double이 공유하는 GitHub JSON 요청 계약이다. */
export type GithubJsonRequester = <T>(
  url: string,
  accessToken: string | undefined,
  options?: GithubJsonRequestOptions,
) => Promise<GithubJsonResponse<T>>;

interface GithubPullRequestItem {
  readonly number?: unknown;
  readonly head?: {
    readonly ref?: unknown;
    readonly repo?: {
      readonly owner?: { readonly login?: unknown };
    } | null;
  } | null;
}

interface GithubGraphqlPullRequestItem {
  readonly number?: unknown;
  readonly headRefName?: unknown;
  readonly headRepositoryOwner?: { readonly login?: unknown } | null;
}

interface GithubGraphqlResponse {
  readonly data?: {
    readonly repository?: {
      readonly pullRequests?: { readonly nodes?: readonly unknown[] };
    } | null;
  };
  readonly errors?: ReadonlyArray<{ readonly message?: unknown }>;
}

type GithubPullRequestLookupState = 'open' | 'closed';

const PULL_REQUEST_LOOKUP_STATES: readonly GithubPullRequestLookupState[] = ['open', 'closed'];
const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';
const PULL_REQUEST_BY_HEAD_QUERY = `
  query PullRequestByHead(
    $owner: String!
    $repo: String!
    $headRefName: String!
    $states: [PullRequestState!]!
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequests(
        first: 100
        states: $states
        headRefName: $headRefName
        orderBy: { field: CREATED_AT, direction: DESC }
      ) {
        nodes {
          number
          headRefName
          headRepositoryOwner { login }
        }
      }
    }
  }
`;

class GithubHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'GithubHttpError';
  }
}

/**
 * 현재 branch와 정확히 일치하는 GitHub PR을 open 우선으로 찾는다.
 * REST의 `head=owner:branch`가 조직 소유 branch에서 빈 결과를 주는 경우를 위해
 * 인증된 GraphQL 조회와 paginated REST client-side 조회를 차례로 fallback한다.
 */
export async function findPullRequestForBranch(
  input: PullRequestLookupInput,
  accessToken: string | undefined,
  requestJson: GithubJsonRequester = githubJson,
): Promise<PullRequestSummary | undefined> {
  for (const state of PULL_REQUEST_LOOKUP_STATES) {
    for (const base of input.baseRemotes) {
      for (const head of input.headRemotes) {
        try {
          const number = await findPullRequestNumber(
            base,
            head.owner,
            input.branchName,
            state,
            accessToken,
            requestJson,
          );
          if (number !== undefined) {
            return { owner: base.owner, repo: base.repo, number };
          }
        } catch (error) {
          if (
            error instanceof GithubHttpError &&
            (error.statusCode === 404 || error.statusCode === 422)
          ) {
            continue;
          }
          throw error;
        }
      }
    }
  }
  return undefined;
}

/** REST exact 조회, GraphQL, REST pagination 순으로 하나의 remote 조합을 조회한다. */
async function findPullRequestNumber(
  base: GithubRemote,
  headOwner: string,
  branchName: string,
  state: GithubPullRequestLookupState,
  accessToken: string | undefined,
  requestJson: GithubJsonRequester,
): Promise<number | undefined> {
  const exactUrl = githubApiUrl(
    `/repos/${encodePathPart(base.owner)}/${encodePathPart(base.repo)}/pulls`,
    {
      state,
      head: `${headOwner}:${branchName}`,
      sort: 'created',
      direction: 'desc',
      per_page: '100',
    },
  );
  const exact = await requestJson<unknown[]>(exactUrl, accessToken);
  const exactNumber = matchingRestPullRequestNumber(exact.value, headOwner, branchName);
  if (exactNumber !== undefined) return exactNumber;

  if (accessToken) {
    try {
      return await findPullRequestNumberWithGraphql(
        base,
        headOwner,
        branchName,
        state,
        accessToken,
        requestJson,
      );
    } catch {
      // GraphQL 권한/일시 오류가 있어도 public REST pagination으로 마지막 복구를 시도한다.
    }
  }

  return findPullRequestNumberByPagination(
    base,
    headOwner,
    branchName,
    state,
    accessToken,
    requestJson,
  );
}

/** 인증 token으로 headRefName을 직접 필터링해 조직 소유 branch PR을 찾는다. */
async function findPullRequestNumberWithGraphql(
  base: GithubRemote,
  headOwner: string,
  branchName: string,
  state: GithubPullRequestLookupState,
  accessToken: string,
  requestJson: GithubJsonRequester,
): Promise<number | undefined> {
  const body = JSON.stringify({
    query: PULL_REQUEST_BY_HEAD_QUERY,
    variables: {
      owner: base.owner,
      repo: base.repo,
      headRefName: branchName,
      states: [state.toUpperCase()],
    },
  });
  const response = await requestJson<GithubGraphqlResponse>(
    GITHUB_GRAPHQL_URL,
    accessToken,
    { method: 'POST', body },
  );
  if (response.value.errors?.length) {
    const message = response.value.errors
      .map((error) => error.message)
      .filter((value): value is string => typeof value === 'string')
      .join('; ');
    throw new Error(message || 'GitHub GraphQL request failed.');
  }
  const nodes = response.value.data?.repository?.pullRequests?.nodes ?? [];
  return matchingGraphqlPullRequestNumber(nodes, headOwner, branchName);
}

/** 인증 없는 public repository도 지원하도록 PR 목록을 page별로 읽어 정확히 대조한다. */
async function findPullRequestNumberByPagination(
  base: GithubRemote,
  headOwner: string,
  branchName: string,
  state: GithubPullRequestLookupState,
  accessToken: string | undefined,
  requestJson: GithubJsonRequester,
): Promise<number | undefined> {
  let url: string | undefined = githubApiUrl(
    `/repos/${encodePathPart(base.owner)}/${encodePathPart(base.repo)}/pulls`,
    { state, sort: 'created', direction: 'desc', per_page: '100' },
  );
  while (url) {
    const response = await requestJson<unknown[]>(url, accessToken);
    const number = matchingRestPullRequestNumber(response.value, headOwner, branchName);
    if (number !== undefined) return number;
    url = nextPageUrl(response.headers);
  }
  return undefined;
}

/** REST PR 배열에서 head owner와 branch가 모두 정확히 같은 첫 PR 번호를 반환한다. */
export function matchingRestPullRequestNumber(
  values: readonly unknown[],
  headOwner: string,
  branchName: string,
): number | undefined {
  for (const value of values) {
    if (!isGithubPullRequestItem(value)) continue;
    const owner = value.head?.repo?.owner?.login;
    if (
      typeof value.number === 'number' &&
      typeof value.head?.ref === 'string' &&
      typeof owner === 'string' &&
      value.head.ref === branchName &&
      owner.toLowerCase() === headOwner.toLowerCase()
    ) {
      return value.number;
    }
  }
  return undefined;
}

/** GraphQL PR 배열에서 head owner와 branch가 모두 정확히 같은 첫 PR 번호를 반환한다. */
function matchingGraphqlPullRequestNumber(
  values: readonly unknown[],
  headOwner: string,
  branchName: string,
): number | undefined {
  for (const value of values) {
    if (!isGithubGraphqlPullRequestItem(value)) continue;
    const owner = value.headRepositoryOwner?.login;
    if (
      typeof value.number === 'number' &&
      value.headRefName === branchName &&
      typeof owner === 'string' &&
      owner.toLowerCase() === headOwner.toLowerCase()
    ) {
      return value.number;
    }
  }
  return undefined;
}

/** GitHub REST/GraphQL JSON을 공통 header와 timeout으로 요청한다. */
export function githubJson<T>(
  url: string,
  accessToken: string | undefined,
  options: GithubJsonRequestOptions = {},
): Promise<GithubJsonResponse<T>> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'newdlops-tab-manager',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    const req = https.request(url, { method: options.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const statusCode = res.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(new GithubHttpError(statusCode, githubErrorMessage(statusCode, body)));
          return;
        }
        try {
          resolve({
            value: (body ? JSON.parse(body) : undefined) as T,
            headers: res.headers,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error('GitHub request timed out.')));
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** GitHub REST pathname과 query parameter로 안전한 API URL을 만든다. */
export function githubApiUrl(pathname: string, params: Record<string, string>): string {
  const url = new URL(`https://api.github.com${pathname}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** GitHub Link header에서 다음 page URL만 반환한다. */
export function nextPageUrl(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers.link;
  const link = Array.isArray(raw) ? raw.join(',') : raw;
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return undefined;
}

/** URL pathname 한 구간에 들어갈 GitHub owner/repository 값을 인코딩한다. */
export function encodePathPart(value: string): string {
  return encodeURIComponent(value);
}

/** REST PR 응답이 head 식별자를 비교할 수 있는 최소 구조인지 판별한다. */
function isGithubPullRequestItem(value: unknown): value is GithubPullRequestItem {
  return !!value && typeof value === 'object';
}

/** GraphQL PR 응답이 head 식별자를 비교할 수 있는 최소 구조인지 판별한다. */
function isGithubGraphqlPullRequestItem(value: unknown): value is GithubGraphqlPullRequestItem {
  return !!value && typeof value === 'object';
}

/** GitHub 오류 body에 message가 있으면 status와 함께 읽기 좋은 문자열로 만든다. */
function githubErrorMessage(statusCode: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.length > 0) {
      return `GitHub API returned ${statusCode}: ${parsed.message}`;
    }
  } catch {
    /* malformed error payload에는 공통 status message를 사용한다. */
  }
  return `GitHub API returned ${statusCode}`;
}
