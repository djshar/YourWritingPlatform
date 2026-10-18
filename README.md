# Your Writing Platform

A React and Vite writing workspace. Signed-in users save one workspace per account to Supabase.

## Configure Supabase

1. Create a Supabase project and enable email/password authentication.
2. In the Supabase SQL Editor, run [`supabase/schema.sql`](./supabase/schema.sql). It creates the workspace table and row-level security policies so authenticated users can only read and change their own workspace.
3. Copy `.env.example` to `.env.local`, then set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to the project URL and publishable/anon key from the Supabase project settings. These frontend values are public; never use a service-role key here.
4. Set the Supabase authentication Site URL to `https://djshar.github.io/YourWritingPlatform/` and add that same URL to the allowed redirect URLs. Sign-up confirmation links explicitly redirect to the app's current origin and path.
5. Start locally with `npm run dev`. Without the Supabase environment values, account screens report that cloud accounts are not configured.

On a user's first login, if no cloud workspace exists, the app imports that browser's existing local workspace and saves it to the signed-in account. A cloud workspace takes precedence on later logins.

## Deploy to GitHub Pages

The repository workflow at [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) builds and deploys the site when code is pushed to `main`. In the GitHub repository settings:

1. Under **Pages**, select **GitHub Actions** as the build and deployment source.
2. Under **Settings → Secrets and variables → Actions → Variables**, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. The anon/publishable key is embedded in the public frontend by design; database security must come from the row-level security policies.
3. Push to `main` or manually run the deployment workflow.

The Vite config and hash-based routes support the project Pages URL at `https://djshar.github.io/YourWritingPlatform/`.
