/**
 * The app's one toast, shown by the layout so it outlives the page that raised
 * it: a publish handed off from the composer reports back wherever the person
 * has gone since. Screen readers get the same news through `announce`.
 */
export type ToastTone = 'success' | 'error' | 'warn';
export type ToastAction = { label: string; href: string };

export const toast = $state<{
	message: string;
	tone: ToastTone;
	action: ToastAction | null;
	announcement: string;
}>({ message: '', tone: 'success', action: null, announcement: '' });

let timer: ReturnType<typeof setTimeout> | null = null;
let announceTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(
	message: string,
	tone: ToastTone = 'success',
	action?: ToastAction | null
) {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
	toast.message = message;
	toast.tone = tone;
	toast.action = action ?? null;
	// Success and warning nudges dismiss themselves; real failures stick
	// around with a close button so they are never missed.
	if (tone !== 'error') {
		timer = setTimeout(() => {
			toast.message = '';
			toast.action = null;
			timer = null;
		}, 5000);
	}
}

export function dismissToast() {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
	toast.message = '';
	toast.action = null;
}

export function announce(message: string) {
	if (announceTimer) clearTimeout(announceTimer);
	// Cleared first so a repeated message is still read out.
	toast.announcement = '';
	announceTimer = setTimeout(() => {
		toast.announcement = message;
		announceTimer = null;
	}, 30);
}
