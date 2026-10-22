# 中继：让不在同一个局域网的电脑互相访问

两个文件，都只要 Node.js（18 以上），不用 `npm install`，也不依赖 claclaw：

| 文件 | 跑在哪 | 干什么 |
| --- | --- | --- |
| `relay.mjs` | 一台外网能访问的服务器（开一个端口就行，不需要域名和证书） | 中转请求 |
| `relay-tunnel.mjs` | 每个要被别人访问的电脑 | 主动连中继，领一个公开地址，把发到这个地址的请求转给本机的服务 |

原理和 ngrok 一类工具一样：家里、公司都不用开端口。中继只管网络，不认识也不关心转发的内容；原来在局域网里怎么请求，现在把地址换成公开地址照样请求。

```
别人（任何能发 HTTPS 请求的程序）
   │  https://服务器IP:8790/t/<名字>/路径
   ▼
relay.mjs（服务器）  ←── 一直连着 ── relay-tunnel.mjs（你的电脑）──→ 本机服务，例如 http://192.168.1.x:8788/路径
```

## 1. 服务器上：运行中继

```sh
scp relay.mjs 用户@服务器:~/relay/
ssh 用户@服务器
cd ~/relay && node relay.mjs --port 8790
```

第一次启动会生成自签证书和注册口令（存在 `relay-data/`，以后重启不变），并打印：

```
中继已启动：https://<服务器IP>:8790
证书指纹（pin）：sha256//OzeM8vd…NE=
注册口令：yNNDO4h8Z4Mve_FK…
```

- **证书指纹**：公开给所有接入的人。没有域名所以证书是自签的，连接方只认这个指纹，换了证书就拒绝。
- **注册口令**：只给要领公开地址的人（跑 `relay-tunnel.mjs` 的人）。只是访问别人的话，不需要它。
- 防火墙放行这个端口（例如 `ufw allow 8790/tcp`，或在云服务商的安全组里加规则）。

开机自启（systemd），把 `用户`、路径换成自己的：

```ini
# /etc/systemd/system/relay.service
[Unit]
Description=relay
After=network-online.target

[Service]
User=用户
WorkingDirectory=/home/用户/relay
ExecStart=/usr/bin/node /home/用户/relay/relay.mjs --port 8790
Restart=always

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now relay
journalctl -u relay -n 20    # 看证书指纹和注册口令
```

## 2. 自己电脑上：连中继，领公开地址

```sh
node relay-tunnel.mjs --relay https://服务器IP:8790 --pin 'sha256//…' --key 注册口令 --to http://本机服务地址
```

- `--to`：要让别人访问的本机服务，例如 claclaw 协同是 `http://192.168.1.x:8788`（协同页「我们的协同地址」里的 IP 版地址，去掉 `/claclaw-peer`）。
- 启动后打印公开地址，例如 `https://服务器IP:8790/t/Xl4PK0UWW-1qGvdnfwvq`。名字存在 `~/.relay-tunnel.json`，重启后不变。
- 名字是随机长串，相当于钥匙：只有拿到地址的人才能访问。访问之后还要过本机服务自己的验证（例如 claclaw 的配对钥匙）。
- 要一直开着：可以用 `nohup … &`；macOS 上要开机自启就用 launchd，Linux 上用 systemd。

## 3. 别人怎么访问

把「公开地址 + 证书指纹」给对方。对方原来在局域网里请求 `http://你的IP:端口/路径`，现在请求 `https://服务器IP:8790/t/<名字>/路径`，再核对证书指纹：

```sh
curl -k --pinnedpubkey 'sha256//…' https://服务器IP:8790/t/<名字>/路径
```

（`-k` 是因为证书是自签的；`--pinnedpubkey` 保证连的确实是这台中继，指纹不对 curl 会直接报错。）

用 claclaw 的话：地址写成 `https://服务器IP:8790/t/<名字>/claclaw-peer#pin=sha256//…`，`#pin=` 后面就是证书指纹，claclaw 会自动核对。

- 自己这边：协同页「我们的协同地址」→「中继地址」填上并保存。之后新配对时，对方会记下这个地址；已经配对的要重新配对一次才会改用中继。
- 对方那边：「向对方申请配对」里填你的这个地址。

## 安全和限制

- 传输是 HTTPS，证书指纹钉死，中间人看不到内容，也冒充不了中继。
- 中继本身能看到经过它的请求内容（它要转发）。你不信任这台服务器的话，就别把敏感内容发过去。claclaw 协同的配对钥匙只有在配对时经过中继一次。
- 单个请求 / 响应最多 1MB；对方最多等 11 分钟回应；隧道 60 秒没连着中继就算离线，访问会得到「对方不在线」。
- 每个来源 IP 每分钟最多 120 个请求。
- 测试用 `--plain`：不用 HTTPS，只在可信网络里临时用。
