# Your Writing Platform

A React and Vite writing workspace. Signed-in users save one workspace per account to Supabase.

## Configure Supabase

1. Create a Supabase project and enable email/password authentication.
2. In the Supabase SQL Editor, run [`supabase/schema.sql`](./supabase/schema.sql). It creates the workspace table and row-level security policies so authenticated users can only read and change their own workspace, plus a private `book-covers` Storage bucket limited to 5 MB JPEG, PNG, WebP, and AVIF images. Re-running the script does not delete workspaces or uploaded covers.
3. Copy `.env.example` to `.env.local`, then set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to the project URL and publishable/anon key from the Supabase project settings. These frontend values are public; never use a service-role key here.
4. Set the Supabase authentication Site URL to `https://djshar.github.io/YourWritingPlatform/` and add that same URL to the allowed redirect URLs. Sign-up confirmation links explicitly redirect to the app's current origin and path.
5. Start locally with `npm run dev`. If Supabase environment values are absent, local development opens an offline preview workspace. Its workspace and profile settings are saved only in that browser and never sync to Supabase. Production builds continue to require Supabase sign-in.

On a user's first login, if no cloud workspace exists, the app imports that browser's existing local workspace and saves it to the signed-in account. A cloud workspace takes precedence on later logins.

Signed-in users can edit a display name, optional short bio, and optional daily writing goal (words or focused writing minutes) under **Profile settings**. These profile settings are saved to Supabase Auth user metadata; the display name appears in the workspace navigation, and the bio is not displayed publicly. Daily goal progress is stored in the current browser's local storage and does not sync between devices. Word goals measure net words added to the workspace since its first load that day; time goals count while the writing editor is focused and the tab is visible.

The workspace includes Light, Dark, and Sepia themes, plus Pestel pink, Stardust blue, and Lavender. Theme choices are saved with the user's workspace.

Each chapter can contain multiple editable pages. Existing chapter text is preserved as Page 1 when the workspace is loaded; added pages begin empty. With **Continuous (keep writing)** checked in the writing toolbar, you can continue writing on the current page after 2,000 non-whitespace characters; a reminder suggests adding a page break. When unchecked, content automatically splits into additional pages at every 2,000 non-whitespace characters, including large pastes. Unchecking Continuous also splits the current page if it already meets the limit. The displayed character count is unchanged and continues to include spaces. Pages and chapters can be deleted with confirmation, while each chapter keeps at least one page and each story keeps at least one chapter. Notes and highlights stay in Notes when their chapter is deleted. Chapter exports and word-goal counts include all pages in order.

Each story can have a subtitle, blurb, author name, and uploaded cover image. The story title is used as the cover title; its subtitle and author appear over the cover. The blurb is saved as story detail and previewed below the cover image, not printed over the cover. Cover text is saved with the existing workspace. Signed-in cover images are stored in the private Supabase Storage bucket under the owning user's ID, with row-level policies preventing other users from requesting images. The app displays covers with expiring signed URLs, so anyone with an active URL can view that image until the URL expires. Offline preview can display an uploaded image temporarily, but does not save it.

## Deploy to GitHub Pages

The repository workflow at [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) builds and deploys the site when code is pushed to `main`. In the GitHub repository settings:

1. Under **Pages**, select **GitHub Actions** as the build and deployment source.
2. Under **Settings → Secrets and variables → Actions → Variables**, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. The anon/publishable key is embedded in the public frontend by design; database security must come from the row-level security policies.
3. Push to `main` or manually run the deployment workflow.

The Vite config and hash-based routes support the project Pages URL at `https://djshar.github.io/YourWritingPlatform/`.
