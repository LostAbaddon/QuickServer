const Path = require('path');
const URL = require('url');
const FS = require('fs/promises');
const Mime = require('mime-types');
const EventEmitter = require('events');
const KOA = require("koa");
const SocketIO = require("socket.io");
const DefaultConfig = {
	useCache: false,
	expire: 10 * 60 * 1000,
	port: 8000,
	socket: 0,
	spa: false,
	site: {},
	config: {
		socket: {
			cors: {
				origin: "*",
				methods: ["GET", "POST"]
			}
		}
	}
};

const LifeCycle = new EventEmitter();

const copyConfig = (cfg1, cfg2) => {
	if (cfg1 instanceof Array) {
		let l = Math.max(cfg1.length, cfg2.length || 0);
		for (let i = 0; i < l; i ++) {
			let c = cfg1[i], v = cfg2[i];
			if (c === undefined) {
				cfg1[i] = v;
			}
			else if (c.toString() === '[object Object]') {
				if (!!v && v.toString() === '[object Object]') {
					cfg1[i] = copyConfig(c, v);
				}
			}
			else if (c instanceof Array) {
				if (v instanceof Array) {
					cfg1[i] = copyConfig(c, v);
				}
			}
		}
	}
	else if (cfg1.toString() === '[object Object]') {
		for (let key in cfg2) {
			let c = cfg1[key], v = cfg2[key];
			if (c === undefined) {
				cfg1[key] = v;
			}
			else if (c.toString() === '[object Object]') {
				if (!!v && v.toString() === '[object Object]') {
					cfg1[key] = copyConfig(c, v);
				}
			}
			else if (c instanceof Array) {
				if (v instanceof Array) {
					cfg1[key] = copyConfig(c, v);
				}
			}
		}
	}
	return cfg1;
};
const preparePath = (path, root) => {
	root = root || process.cwd();
	if (path.indexOf('/') !== 0 && !path.match(/^\w:[\/\\]/)) {
		path = Path.join(root, path);
	}
	return path;
};
const getIPAddress = () => {
	var interfaces = require('os').networkInterfaces();
	for (let devName in interfaces) {
		let iface = interfaces[devName];
		for (let i = 0; i < iface.length; i ++) {
			let alias = iface[i];
			if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
				return alias.address;
			}
		}
	}
};
const init = (cfg) => {
	// 读取配置
	var filepath = process.argv[2] || 'config.json';
	filepath = preparePath(filepath);

	var config;
	try {
		config = require(filepath);
	}
	catch {
		config = {};
	}
	config = copyConfig(config, DefaultConfig);
	if (!!cfg) {
		if (typeof cfg === 'string') {
			cfg = {site: {'/': cfg}};
		}
		config = copyConfig(cfg, config);
	}

	// 调整配置
	var pathMap = [];
	for (let root in config.site) {
		let url = root.replace(/\\+/g, '/');
		let path = preparePath(config.site[root]);
		delete config.site[root];
		config.site[url] = path;
		pathMap.push(url);
	}
	pathMap.sort((p1, p2) => p2.length - p1.length);
	if (config.port * 1 !== config.port) config.port = DefaultConfig.port;
	if (!(config.socket > 0)) {
		config.socket = config.port;
	}
	LifeCycle.emit('configLoaded', config);

	var resourceCache = new Map();
	var webServer = new KOA();
	webServer.use(async (ctx, next) => {
		var url = ctx.request.url;
		console.log('[REQUEST]: ' + url);
		url = URL.parse(url).pathname;
		var match = null;
		pathMap.some(domain => {
			var pos = url.indexOf(domain);
			if (pos !== 0) return;
			match = domain;
			return true;
		});
		console.log('  [MATCH]: ' + match);
		if (!match) return await next();
		var folder = config.site[match];
		if (!folder) return await next();
		var filepath = url.replace(match, '/');
		var filetype = filepath.match(/\.(\w+)$/);
		filepath = Path.join(folder, filepath);
		if (!filetype) filetype = null;
		else filetype = filetype[1].toLowerCase();
		var filemime = '';
		if (filetype === null) {
			filetype = 'html';
			filepath = Path.join(filepath, 'index.html');
		}
		filemime = Mime.types[filetype] || 'text/plain';
		var content, needCache = false;
		if (['html', 'js', 'json', 'css', 'txt', 'xml'].includes(filetype)) {
			needCache = !!config.useCache;
		}
		if (needCache) {
			let cache = resourceCache.get(filepath);
			if (!!cache) {
				let timestamp = cache.timestamp;
				if (config.expire >= 0 && Date.now() - timestamp > config.expire) {
					resourceCache.delete(filepath);
				}
				else {
					content = cache.content;
				}
			}
		}
		if (!content) {
			try {
				content = await FS.readFile(filepath);
			}
			catch (err) {
				if (cfg.spa && filepath.indexOf('index.html') >= 0) {
					let redir = Path.join(folder, 'index.html');
					console.log('  [REDIR]: ' + redir);
					try {
						content = await FS.readFile(redir);
					}
					catch (e) {
						needCache = false;
						console.error(url);
						console.error(e);
						content = '';
					}
				}
				else {
					needCache = false;
					console.error(url);
					console.error(err);
					content = '';
				}
			}
			if (needCache && !!content) {
				content = content.toString();
				resourceCache.set(filepath, {content, timestamp: Date.now()});
			}
		}
		ctx.body = content;
		ctx.type = filemime;

		await next();
	});
	var server = require('http').createServer(webServer.callback());
	LifeCycle.emit('webReady', webServer);

	// 初始化SocketIO
	var socketServer;
	if (config.port === config.socket) {
		socketServer = SocketIO(server, config.config.socket);
	}
	else {
		socketServer = SocketIO(config.socket, config.config.socket);
	}
	LifeCycle.emit('socketReady', socketServer);

	server.listen(config.port);
	LifeCycle.emit('ready', server);

	console.log('Server Ready: ' + getIPAddress());
};

module.exports = {
	LifeCycle,
	start: init
};