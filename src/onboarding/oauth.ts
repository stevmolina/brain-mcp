/** URL shapes for the one-time GitHub authorization create_brain uses. */

export function githubOAuthCallbackUrl(mcpResourceUrl: string): string {
  return new URL('/oauth/github/callback', mcpResourceUrl).href;
}

export function githubAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

/** Body for POST /user/repos. Always private. Installation tokens cannot call this. */
export function privateRepoBody(name: string): {
  name: string;
  private: true;
  auto_init: true;
  description: string;
} {
  return {
    name,
    private: true,
    auto_init: true,
    description: 'Agent Brain. Claims live in this repository as markdown.',
  };
}
