import * as http from 'node:http';
import * as https from 'node:https';
import CacheableLookup from 'cacheable-lookup';
import { HttpProxyAgent, HttpsProxyAgent } from 'hpagent';
import type { LookupFunction } from 'node:net';

// A shared DNS cache. `lookup: false` stops cacheable-lookup from silently
// falling back to dns.lookup, which is what makes the caching worthwhile.
const cache = new CacheableLookup({
	maxTtl: 3600, // 1 hour
	errorTtl: 30, // 30 seconds
	lookup: false,
});

const _http = new http.Agent({
	keepAlive: true,
	keepAliveMsecs: 30 * 1000,
	lookup: cache.lookup as unknown as LookupFunction,
} as http.AgentOptions);

const _https = new https.Agent({
	keepAlive: true,
	keepAliveMsecs: 30 * 1000,
	lookup: cache.lookup as unknown as LookupFunction,
} as https.AgentOptions);

/**
 * Returns the HTTP agents used by downloadUrl. When a forward proxy is
 * configured the requests go through hpagent (which in turn does its own DNS).
 */
export function getAgents(proxy?: string | false): { httpAgent: http.Agent; httpsAgent: https.Agent } {
	const httpAgent = proxy
		? new HttpProxyAgent({
			keepAlive: true,
			keepAliveMsecs: 30 * 1000,
			maxSockets: 256,
			maxFreeSockets: 256,
			scheduling: 'lifo',
			proxy,
		})
		: _http;

	const httpsAgent = proxy
		? new HttpsProxyAgent({
			keepAlive: true,
			keepAliveMsecs: 30 * 1000,
			maxSockets: 256,
			maxFreeSockets: 256,
			scheduling: 'lifo',
			proxy,
		})
		: _https;

	return { httpAgent, httpsAgent };
}
