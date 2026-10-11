/**
 * The open composer, as the header sees it. Write stays useful on the compose
 * page while a post is open there, and clicking it has to save that post
 * before clearing, which only the editor can do, so it registers how.
 * Written in the browser only: module state is shared between requests on
 * the server.
 */
export const composeSession = $state<{
	/** An editor is mounted; until then the header guesses from the URL. */
	active: boolean;
	/** Something is open that Write would put away: a saved post or typed text. */
	hasContent: boolean;
	startNew: (() => void) | null;
}>({ active: false, hasContent: false, startNew: null });
