/**
 * Test fixture: exercise the seam from inside a real composition.
 *
 * It waits for the composition to settle, calls `ctx.web.search()`, and logs a
 * single PROBE line naming the outcome. With the Kagi provider pinned, a
 * credential error proves the pinned provider was selected and reached, and a
 * result proves the whole path mapped Kagi's response.
 */
export const name = 'kagi-probe';
export const inject = ['web'];

export function apply(ctx) {
	setTimeout(async () => {
		try {
			const result = await ctx.web.search({ query: 'probe query', maxResults: 5 });
			console.log(`PROBE ok sources=${result.sources.length} ${JSON.stringify(result.sources)}`);
		} catch (error) {
			console.log(`PROBE error code=${error?.code} message=${String(error?.message).split('\n')[0]}`);
		}
	}, 3000);
}
