import { Router } from 'itty-router';
import { RequestWrapper } from './worker';
import StripeServer from './StripeServer';

const stripeRouter = Router<RequestWrapper>();

stripeRouter.post('/v1/stripe/webhooks', async (request) => {
	const stripe = StripeServer.getInstance(request.env);
	const bodyText = await request.text();
	let body: { [key: string]: any } = JSON.parse(bodyText);

	let data;
	let eventType;
	const webhookSecret = request.env.STRIPE_WEBHOOK_SECRET;
	if (webhookSecret) {
		let event;
		let signature = request.headers.get('stripe-signature');

		if (!signature) throw new Error('No signature provided');

		try {
			event = await stripe.webhooks.constructEventAsync(bodyText, signature, webhookSecret);
		} catch (err: any) {
			console.log(`Webhook signature verification failed. ${err.message}`);
			throw new Error('Invalid signature');
		}
		data = event.data;
		eventType = event.type;
	} else {
		data = body;
		eventType = body['type'];
	}

	console.log(`Received event with type: ${eventType}`);

	const customer_id = data.object.customer;
	switch (eventType) {
		case 'customer.subscription.deleted':
		case 'customer.subscription.updated':
		case 'customer.subscription.created':
		case 'customer.subscription.paused':
			const status = data.object.status;
			if (status === 'active') {
				// If subscription is active, update user's subscription to 'pro' tier
				const subscription_id = data.object.id;
				const subscription_end_date = data.object.current_period_end;
				const stripe_id = data.object.customer;
				const sub = await request.supabaseClient
					.from('profiles')
					.update({
						plan: 'pro',
						subscription_id: subscription_id,
						subscription_end_date: new Date(subscription_end_date * 1000).toISOString(),
						stripe_id: stripe_id,
					})
					.eq('stripe_id', customer_id)
					.select('*')
					.single();

				if (sub.error) throw new Error(`Failed to update subscription: ${JSON.stringify(sub.error)}`);
			} else {
				// For all other statuses, update user's subscription to 'free' tier
				const sub = await request.supabaseClient
					.from('profiles')
					.update({
						plan: 'free',
						subscription_id: null,
						subscription_end_date: null,
					})
					.eq('stripe_id', customer_id)
					.select('*')
					.single();

				if (sub.error) throw new Error(`Failed to update subscription: ${sub.error.message}`);
			}
		default:
		// Unhandled event type
	}
});

export default stripeRouter;
