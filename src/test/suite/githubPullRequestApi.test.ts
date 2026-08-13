import * as assert from 'assert';
import {
  findPullRequestForBranch,
  type GithubJsonRequestOptions,
  type GithubJsonRequester,
  type GithubJsonResponse,
  type GithubRemote,
} from '../../githubPullRequestApi';

const origin: GithubRemote = {
  remoteName: 'origin',
  owner: 'kodebox-io',
  repo: 'vcm',
};

/** 테스트 JSON 값을 실제 requester와 같은 응답 구조로 감싼다. */
function response<T>(value: T, link?: string): GithubJsonResponse<T> {
  return { value, headers: link ? { link } : {} };
}

/** 실제 vcm #392와 같은 REST PR 응답 최소 구조를 만든다. */
function pullRequest(number: number, owner: string, branch: string): unknown {
  return {
    number,
    head: { ref: branch, repo: { owner: { login: owner } } },
  };
}

suite('GitHub pull request lookup', () => {
  test('uses GraphQL when REST owner:branch filtering misses an organization branch', async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const requester: GithubJsonRequester = async <T>(
      url: string,
      _token: string | undefined,
      options: GithubJsonRequestOptions = {},
    ) => {
      requests.push({ url, method: options.method ?? 'GET', body: options.body });
      if (url === 'https://api.github.com/graphql') {
        return response({
          data: {
            repository: {
              pullRequests: {
                nodes: [{
                  number: 392,
                  headRefName: 'vcm-ir-curation-badge',
                  headRepositoryOwner: { login: 'kodebox-io' },
                }],
              },
            },
          },
        } as T);
      }
      return response([] as T);
    };

    const result = await findPullRequestForBranch(
      {
        branchName: 'vcm-ir-curation-badge',
        baseRemotes: [origin],
        headRemotes: [origin],
      },
      'github-token',
      requester,
    );

    assert.deepStrictEqual(result, { owner: 'kodebox-io', repo: 'vcm', number: 392 });
    assert.strictEqual(requests.length, 2);
    assert.ok(new URL(requests[0].url).searchParams.has('head'));
    assert.strictEqual(requests[1].method, 'POST');
    const graphqlBody = JSON.parse(requests[1].body ?? '{}') as {
      variables?: Record<string, unknown>;
    };
    assert.deepStrictEqual(graphqlBody.variables, {
      owner: 'kodebox-io',
      repo: 'vcm',
      headRefName: 'vcm-ir-curation-badge',
      states: ['OPEN'],
    });
  });

  test('scans REST pages for public repositories without an authentication token', async () => {
    const requestUrls: string[] = [];
    const requester: GithubJsonRequester = async <T>(url: string) => {
      requestUrls.push(url);
      const parsed = new URL(url);
      if (parsed.searchParams.has('head')) return response([] as T);
      if (!parsed.searchParams.has('page')) {
        return response(
          [pullRequest(391, 'another-owner', 'vcm-ir-curation-badge')] as T,
          '<https://api.github.com/repos/kodebox-io/vcm/pulls?state=open&page=2>; rel="next"',
        );
      }
      return response([
        pullRequest(392, 'kodebox-io', 'vcm-ir-curation-badge'),
      ] as T);
    };

    const result = await findPullRequestForBranch(
      {
        branchName: 'vcm-ir-curation-badge',
        baseRemotes: [origin],
        headRemotes: [origin],
      },
      undefined,
      requester,
    );

    assert.strictEqual(result?.number, 392);
    assert.strictEqual(requestUrls.length, 3);
    assert.ok(!new URL(requestUrls[1]).searchParams.has('head'));
    assert.strictEqual(new URL(requestUrls[2]).searchParams.get('page'), '2');
  });

  test('accepts only an exact head owner and branch match from REST', async () => {
    let requestCount = 0;
    const requester: GithubJsonRequester = async <T>() => {
      requestCount++;
      return response([
        pullRequest(390, 'kodebox-io', 'other-branch'),
        pullRequest(392, 'Kodebox-IO', 'vcm-ir-curation-badge'),
      ] as T);
    };

    const result = await findPullRequestForBranch(
      {
        branchName: 'vcm-ir-curation-badge',
        baseRemotes: [origin],
        headRemotes: [origin],
      },
      'github-token',
      requester,
    );

    assert.strictEqual(result?.number, 392);
    assert.strictEqual(requestCount, 1);
  });

  test('does not scan REST pages after an authenticated GraphQL no-match result', async () => {
    const requestUrls: string[] = [];
    const requester: GithubJsonRequester = async <T>(url: string) => {
      requestUrls.push(url);
      if (url === 'https://api.github.com/graphql') {
        return response({
          data: { repository: { pullRequests: { nodes: [] } } },
        } as T);
      }
      return response([] as T);
    };

    const result = await findPullRequestForBranch(
      {
        branchName: 'branch-without-pr',
        baseRemotes: [origin],
        headRemotes: [origin],
      },
      'github-token',
      requester,
    );

    assert.strictEqual(result, undefined);
    assert.strictEqual(requestUrls.length, 4);
    assert.deepStrictEqual(
      requestUrls.map((url) => url === 'https://api.github.com/graphql'),
      [false, true, false, true],
    );
  });
});
