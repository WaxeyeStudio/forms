export interface Env {
	ESPOCRM_API_URL: string;
	ESPOCRM_API_KEY: string;
	WORKER_API_SECRET: string;
}

interface FormData {
	client: string;
	[key: string]: unknown;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Only handle /f/* routes
		const match = url.pathname.match(/^\/f\/([a-zA-Z0-9_-]+)$/);
		if (!match) {
			return new Response('Not Found', { status: 404 });
		}

		const client = match[1];

		// Only accept POST requests for form submissions
		if (request.method === 'GET') {
			// Return a simple form page for testing
			return new Response(
				`<html><body><h1>Waxeye Forms - ${client}</h1><p>Form endpoint for client: ${client}</p></body></html>`,
				{ headers: { 'Content-Type': 'text/html' } }
			);
		}

		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', { status: 405 });
		}

		// Verify worker secret from header
		const authHeader = request.headers.get('X-Worker-Secret');
		if (authHeader !== env.WORKER_API_SECRET) {
			return new Response('Unauthorized', { status: 401 });
		}

		// Parse form submission
		let submission: FormData;
		try {
			const contentType = request.headers.get('Content-Type') || '';
			if (contentType.includes('application/json')) {
				submission = await request.json();
			} else {
				const body = await request.formData();
				submission = { client };
				for (const [key, value] of body.entries()) {
					submission[key] = value;
				}
			}
		} catch (e) {
			return new Response('Invalid form data', { status: 400 });
		}

		// Honeypot check
		if (submission['company_website'] || submission['address2']) {
			// Silently accept but don't process (bot detection)
			return new Response(JSON.stringify({ success: true }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		// Validate required fields
		if (!submission.name && !submission.email) {
			return new Response(JSON.stringify({ error: 'Name or email is required' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		// Forward to EspoCRM API
		try {
			const response = await fetch(`${env.ESPOCRM_API_URL}/FormSubmission`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Api-Key': env.ESPOCRM_API_KEY,
				},
				body: JSON.stringify({
					name: submission.name || '',
					email: submission.email || '',
					phone: submission.phone || '',
					message: submission.message || '',
					client: client,
					source: 'website',
					submittedAt: new Date().toISOString(),
					metadata: JSON.stringify(submission),
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error('EspoCRM API error:', response.status, errorText);
				return new Response(JSON.stringify({ error: 'Submission failed' }), {
					status: 502,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			return new Response(JSON.stringify({ success: true }), {
				headers: { 'Content-Type': 'application/json' }
			});
		} catch (e) {
			console.error('EspoCRM forward error:', e);
			return new Response(JSON.stringify({ error: 'Service unavailable' }), {
				status: 503,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	},
};
