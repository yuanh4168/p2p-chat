export const strings = {
  // 通用
  WELCOME: '===== P2P 聊天系统 (UDP) =====',
  HELP_PROMPT: '输入 /help 查看命令帮助',
  DIRECT_INPUT: '直接输入文本即可发送到当前群组/话题',
  UNKNOWN_COMMAND: '未知命令: {cmd}',
  ERROR_PREFIX: '错误：{msg}',

  // 身份
  FIRST_RUN_CREATE: '首次运行：创建身份',
  SET_PASSWORD: '设置密码：',
  IDENTITY_CREATED: '身份已创建，你的公钥：{pubkey}',
  WELCOME_BACK: '欢迎回来，用户 {shortPub}...',
  ENTER_PASSWORD: '输入密码：',
  PRIVATE_KEY_CORRUPTED: '存储的私钥已损坏，请重置 data/chat.db 并重新启动。',
  PASSWORD_WRONG: '密码错误或数据损坏，请确认密码或删除 data/chat.db 重新创建。',
  LOGIN_SUCCESS: '登录成功，你的公钥：{pubkey}',

  // DHT & UDP
  DHT_LISTENING: 'DHT 正在 UDP 端口 {port} 监听',
  DHT_INIT_FAIL: 'DHT 初始化失败，请检查网络或端口',
  UDP_LISTENING: 'UDP 传输正在监听端口 {port}',
  UDP_INIT_FAIL: 'UDP 传输初始化失败，请检查端口是否被占用',

  // Tailscale
  TAILSCALE_IP: 'Tailscale IP: {ips} （可用于 /connect 连接）',
  TAILSCALE_NOT_FOUND: '未检测到 Tailscale 网络，您仍可使用公网 IP 或手动连接。',
  TAILSCALE_NOT_INSTALLED: '未检测到 Tailscale。请访问 https://tailscale.com/download 下载并安装 Tailscale，然后登录您的账号（tailscale login），即可获得安全的内网 IP 用于连接。',
  TAILSCALE_ERROR: '检测 Tailscale 出错: {msg}',

  // 连接
  CONNECTION_ATTEMPT: '正在连接 {ip}:{port}...',
  CONNECTION_TIMEOUT: '连接 {ip}:{port} 超时',
  HANDSHAKE_SUCCESS: '与 {ip}:{port} 握手成功，延迟 {delay}ms',
  KNOWN_NODES_CONNECT: '已尝试连接 {count} 个已知节点...',

  // 群组
  GROUP_CREATED: '群组已创建：{id}（默认话题：{topic}）',
  GROUP_SWITCHED: '已切换到群组 {name}（{id}），话题：{topic}',
  GROUP_NOT_EXIST: '群组不存在',
  NOT_MEMBER: '您不是该群组的成员',
  ALREADY_MEMBER: '已是该群组成员',
  JOIN_REQUEST_SENT: '已向群组 {id} 发送加入请求',
  JOIN_APPROVED: '已批准 {pubkey} 加入群组 {id}',
  JOIN_APPROVAL_RECEIVED: '已批准加入群组 {id}',
  GROUP_RENAMED: '群组名称已更新为：{name}',
  GROUP_DELETED: '群组 {id} 已删除（已通知成员）',
  GROUP_LEFT: '您已退出群组 {id}',
  GROUP_LEAVE_NOTIFICATION: '{pubkey} 已退出群组 {id}',
  MEMBER_LIST_TITLE: '成员列表：',
  NO_GROUPS: '暂无群组',
  NO_MESSAGES: '暂无消息',
  DECRYPT_FAIL: '[无法解密]',

  // 消息
  ERROR_NO_GROUP: '未选择群组，请先 /use',
  ERROR_NO_GROUP_KEY: '无群组密钥',
  ERROR_MSG_DECRYPT: '消息解密失败: {msg}',
  ERROR_MSG_ENCRYPTED_NO_KEY: '收到加密消息，但没有群组 {groupId} 的密钥，请先加入该群组',
  MSG_PROCESS_FAIL: '消息处理失败: {msg}',

  // 文件
  FILE_RECEIVED: '收到文件：{filename} ({size} 字节) 来自 {from} 在群组 {group} 话题 {topic}',
  FILE_DOWNLOAD_HINT: '使用 /download {id} 下载到 files/ 目录',
  FILE_SENT: '已发送文件：{filename} ({size} 字节)，等待对方确认...',
  FILE_ACK_RECEIVED: '文件 {filename} 已被至少一个成员确认接收',
  FILE_SEND_TIMEOUT: '文件 {filename} 发送超时，可能未送达',
  FILE_DOWNLOAD_SUCCESS: '文件已保存至：{path}',
  FILE_DOWNLOAD_ERROR: '没有待下载的文件消息 ID: {id}，可能已过期或不存在',
  FILE_TOO_LARGE: '文件太大（{size} 字节），编码后消息大小 {byteLen} 字节超过 UDP 限制（{mtu}），请压缩或分片发送。',

  // 在线
  ONLINE_TITLE_ALL: '所有连接节点 ({count})',
  ONLINE_TITLE_GROUP: '群组 {group} 在线用户 ({count})',
  ONLINE_TITLE_TOPIC: '话题 {topic} 在线用户 ({count})',
  ONLINE_NO_USERS: '当前没有在线用户',

  // 帮助
  HELP: `===== 命令帮助 =====
  /create <名称>            - 创建新群组
  /join <群组ID>            - 申请加入群组
  /use <群组ID>             - 切换到指定群组
  /topic <话题名>           - 切换/创建话题（"general" 切回默认）
  /approve <公钥/前缀> <群组ID> - 批准加入请求（管理员）
  /list                    - 列出所有群组
  /members <群组ID>         - 查看群组成员
  /msgs [群组ID] [话题ID]   - 显示最近20条消息
  /connect <IP> [端口]      - 手动连接对等节点
  /tailscale               - 显示本机 Tailscale IP
  /nick [<pubkey>] <昵称>  - 设置昵称
  /online [all|group]      - 显示在线用户
  /hash                    - 显示您的完整公钥
  /renamegroup <新名称>    - 重命名当前群组（管理员）
  /deletegroup <群组ID>    - 解散群组（管理员，会通知所有成员）
  /leave                   - 退出当前群组（非管理员）
  /deletetopic <ID或名称>  - 删除话题（管理员）
  /sendfile <文件路径>     - 发送文件（端到端加密，自动确认送达）
  /download <消息ID>       - 下载并保存待接收的文件到 files/ 目录
  /help                    - 显示此帮助
  /exit                    - 退出程序`,

  // 命令错误
  ERR_NEED_GROUP_NAME: '需要群组名称',
  ERR_NEED_GROUP_ID: '需要群组 ID',
  ERR_NEED_FILE_PATH: '用法：/sendfile <文件路径>',
  ERR_FILE_NOT_EXIST: '文件不存在',
  ERR_NEED_MSG_ID: '用法：/download <消息ID>',
  ERR_NEED_TOPIC: '未选择群组',
  ERR_NOT_ADMIN: '您不是该群组的管理员',
  ERR_ADMIN_CANT_LEAVE: '管理员不能退出群组，请使用 /deletegroup 解散',
  ERR_TOPIC_NOT_FOUND: '未找到话题 "{input}"',
  ERR_TOPIC_NOT_UNIQUE: '话题名称 "{input}" 不唯一，请使用ID删除',
  ERR_APPROVE_USAGE: '用法：/approve <申请人公钥/前缀> <群组ID>',
  ERR_REQUESTER_NOT_FOUND: '未找到匹配 "{input}" 的公钥',
  ERR_REQUESTER_NOT_CONNECTED: '请求者未连接或没有共享密钥',
  ERR_GROUP_KEY_NOT_FOUND: '未找到群组密钥',
  ERR_NICK_USAGE: '用法：/nick [<pubkey>] <昵称>',
  ERR_RENAME_USAGE: '用法：/renamegroup <新名称>',
  ERR_DELETE_GROUP_USAGE: '用法：/deletegroup <群组ID>',
  ERR_TOPIC_USAGE: '用法：/deletetopic <话题ID或名称>',
  ERR_MSGS_USAGE: '需要群组 ID',

  // 话题 & 其他
  TOPIC_LIST: '话题列表：{topics}',
  TOPIC_CREATED: '话题已创建：{name} (ID: {id})',
  TOPIC_SWITCHED: '已切换到话题：{name}',
  TOPIC_SWITCHED_DEFAULT: '已切换到默认话题：general',
  TOPIC_DELETED: '已删除话题 {id}',
  TOPIC_DELETED_SWITCH_DEFAULT: '已删除话题，切换到默认话题：{name}',
  NICK_CURRENT: '当前昵称：{nick}',
  NICK_SET: '昵称已设置为：{nick}',
  LOCAL_NICK_SET: '已为 {pubkey} 设置本地昵称：{nick}',
  HASH_DISPLAY: '你的完整公钥：{pubkey}',
  JOIN_REQUEST_RECEIVED: '[加入请求] {pubkey} 想加入群组 {id}',
  JOIN_APPROVE_HINT: '使用 /approve <申请人公钥> <群组ID> 批准',
  SYNC_MSGS: '已向 {count} 个节点发起连接，等待握手...',
  DHT_LOOKUP_FAIL: 'DHT 查找失败，将广播请求',
  DHT_NOT_FOUND: 'DHT 未找到该群组的活跃节点，将广播请求（可能无法送达）',
};