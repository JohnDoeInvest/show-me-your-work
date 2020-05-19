# Show Me Your Work! [![Sponsor](https://johndoeinvest.com/logo-jdi-tag.png)](https://johndoeinvest.com/) [![Build status](https://api.travis-ci.com/JohnDoeInvest/show-me-your-work.svg?branch=master)](https://travis-ci.com/JohnDoeInvest/show-me-your-work)

Nothing is more detrimental to an organization than not being able to see and follow progress.

Recognize this? Someone identifies a need for a new feature. The requestor spends a lot of time specifying this new feature. The task is handed over to development for implementation. It gets implemented, passes all the tests and QA. But the requestor is unable to see the result until a very late stage – at which point he or she sees that the request has been misinterpreted… In many cases the requestor also gets frustrated because he or she does not feel that “anything is happening”.

If you are a small startup with everyone on site – this is not a big issue. You simply walk over to your colleague for an update. But once you grow beyond that point or if you, like us at John Doe Invest, work from home most of the time – it becomes an issue.

We’re not claiming to have invented sliced bread here. After running several businesses - where this challenge was never solved properly - we decided to solve this first before launching products and services; get it right to begin with ™.

We Googled and found inspiration in others that built upon frameworks and tools such as Surge (https://medium.com/onfido-tech/travis-surge-github-auto-deploy-every-pr-branch-and-tag-a6c8c790831f), Heroku (https://devcenter.heroku.com/articles/github-integration-review-apps) and we suspect there are many more.

Since we don’t use these specific services and want to be able to use this on highly regulated projects (where we have to run most tools internally) we ended up here – with an open source project called “Show me your work” which builds directly on top of GitHub and can be run on your own servers.

## Project goals
-	Once installed, it builds every PR and/or branch from GitHub automatically
-	Makes each PR and/or branch available on an easy to access subdomain
-	Can use the same server instance to spin up multiple PRs/branches
-	Use as few tools and services as possible

## Overall architecture
NGINX is truly a swiss army knife, and since all our services uses this for terminating SSL and splitting traffic to upstream microservices etc, the choice to continue building on this was an easy one.

Next, we needed to find a way to dynamically update the NGINX configuration. Obviously changing the config file(s) and/or restarting was out of the question from a sysadmin/security point of view. A little Googling later we realized that the LUA support that can be enabled in NGINX fits the bill.

Since LUA in NGINX supports the Redis database – this was the final piece of the puzzle.

Effectively, the Redis database holds a mapping between “subdomain” and “upstream server port”. The “Show me your work” scripts updates the database and NGINX uses this to map incoming requests.

## Server requirements
* Node
* Nginx, [custom build](#custom-nginx-build)
* Redis

## Installation
Assuming you have the above requirements installed you need to setup the Nginx config, we have a sample one [here](#configuration---single-server). Then we only need to add the show-me-your-work code. So clone the repository and run `npm install`. After that you start the server with `node src/index.js`, you can pass options via the following environment variables.

| Name | Description | Default |
| --- | --- | --- |
| PORT | The port to listen at | 3000 |
| WEBHOOK_SECRET | The GitHub webhook secret | |
| GITHUB_ACCESS_TOKEN | An access token to GitHub, required to fetch from private repositories | |
| DEPLOY_PULL_REQUESTS | Should the application deploy pull requests | true |
| DEPLOY_BRANCHES | Should the application deploy branches | false |
| BRANCH_BLACKLIST | Which branches should we not deploy, comma seperated names | |
| REDIS_HOST | What host Redis is running on | localhost |
| REDIS_PORT | What port Redis is running on  | 6379 |

## Subdomain structure
The subdomians have prefixes so as to not clash. Branches have the subdomain structure of `branch-BRANCH_NAME` and pull requests have the structure of `pr-PR_NUMBER`. So if we run the server on `example.com` the pull request with number 1 would be reached at `pr-1.example.com`

## Custom Nginx build
NOTE: Below we compile NGINX and the Openresty module (https://openresty.org/en/) from source because we use a couple of custom components. This is overly complicated – we know. We hope that people that are used to working with Openresty will jump in and create another installation section based on the official releases. In theory it should only be to install Openresty, Redis and then jump to configuration...

NOTE2: We use Centos for all servers so commands/paths assumes this.

Effectively the process is already well documented here: https://github.com/openresty/lua-nginx-module#installation

In the instructions below we also include Nchan (https://nchan.io/) and GeoIP2 from MaxMind (https://www.maxmind.com/)
```
https://nginx.org/download/nginx-1.18.0.tar.gz
tar xzf nginx-1.18.0.tar.gz

git clone https://github.com/slact/nchan.git
https://github.com/slact/nchan/commit/82b766cd133c060542c2420b19c13d74de6cc0c6

wget -O luajit2.tar.gz https://github.com/openresty/luajit2/archive/v2.1-20200102.tar.gz
tar xzf luajit2.tar.gz
cd luajit2-2.1-20200102/
make && sudo make install
export LUAJIT_LIB=/usr/local/lib/
export LUAJIT_INC=/usr/local/include/luajit-2.1
cd ..

wget -O ngx_devel_kit.tar.gz https://github.com/vision5/ngx_devel_kit/archive/v0.3.1.tar.gz
tar xzf ngx_devel_kit.tar.gz

wget -O lua-nginx-module.tar.gz https://github.com/openresty/lua-nginx-module/archive/v0.10.16rc5.tar.gz
tar xzf lua-nginx-module.tar.gz

wget -O libmaxminddb.tar.gz https://github.com/maxmind/libmaxminddb/releases/download/1.4.2/libmaxminddb-1.4.2.tar.gz
tar xzf libmaxminddb.tar.gz
cd libmaxminddb-1.4.2/
./configure
make
make check
sudo make install
sudo ldconfig
cd ..

wget -O ngx_http_geoip2.tar.gz https://github.com/leev/ngx_http_geoip2_module/archive/3.3.tar.gz
tar xzf ngx_http_geoip2.tar.gz

wget -O echo-nginx-module.tar.gz https://github.com/openresty/echo-nginx-module/archive/v0.62rc1.tar.gz
tar xzf echo-nginx-module.tar.gz

cd nginx-1.18.0
./configure --prefix=/etc/nginx \
            --with-ld-opt="-Wl,-rpath,$LUAJIT_LIB" \
            --sbin-path=/usr/sbin/nginx \
            --modules-path=/usr/lib64/nginx/modules \
            --conf-path=/etc/nginx/nginx.conf \
            --error-log-path=/var/log/nginx/error.log \
            --pid-path=/var/run/nginx.pid \
            --lock-path=/var/run/nginx.lock \
            --user=nginx \
            --group=nginx \
            --build=CentOS \
            --builddir=nginx-1.18.0 \
            --with-select_module \
            --with-poll_module \
            --with-threads \
            --with-file-aio \
            --with-http_ssl_module \
            --with-http_v2_module \
            --with-http_realip_module \
            --with-http_addition_module \
            --with-http_sub_module \
            --with-http_dav_module \
            --with-http_flv_module \
            --with-http_mp4_module \
            --with-http_gunzip_module \
            --with-http_gzip_static_module \
            --with-http_auth_request_module \
            --with-http_random_index_module \
            --with-http_secure_link_module \
            --with-http_degradation_module \
            --with-http_slice_module \
            --with-http_stub_status_module \
            --http-log-path=/var/log/nginx/access.log \
            --http-client-body-temp-path=/var/cache/nginx/client_temp \
            --http-proxy-temp-path=/var/cache/nginx/proxy_temp \
            --http-fastcgi-temp-path=/var/cache/nginx/fastcgi_temp \
            --http-uwsgi-temp-path=/var/cache/nginx/uwsgi_temp \
            --http-scgi-temp-path=/var/cache/nginx/scgi_temp \
            --with-mail=dynamic \
            --with-mail_ssl_module \
            --with-stream \
            --with-stream_ssl_module \
            --with-stream_realip_module \
            --with-stream_ssl_preread_module \
            --with-compat \
            --with-pcre \
            --with-pcre-jit \
            --with-debug \
            --add-module=../nchan \
            --add-module=../ngx_devel_kit-0.3.1 \
            --add-module=../lua-nginx-module-0.10.16rc5 \
            --add-module=../ngx_http_geoip2_module-3.3 \
            --add-module=../echo-nginx-module-0.62rc1 
            
make
sudo make install

useradd --system --home /var/cache/nginx --shell /sbin/nologin --comment "nginx user" --user-group nginx
mkdir -p /var/cache/nginx
```

Possible issues with the above:
  * Nchan does some compares that recent GCC dislikes. Until this is fixed, remove -Wall from nginx-1.18.0/Makefile
  * Nchan has a bug that we have run into and had to manually fix before build. See https://github.com/slact/nchan/issues/534 and the specific line to be commented out https://github.com/slact/nchan/commit/82b766cd133c060542c2420b19c13d74de6cc0c6
  
Here comes a twist: to get the LUA scripts, we need to install the Openresty release as well:
```
yum-config-manager --add-repo https://openresty.org/package/centos/openresty.repo
yum install openresty
```

Possible issues with the above:
  * Openresty offical builds does not quite match the Nginx ones. So if nginx does not start, showing `failed to load the 'resty.core' module` in the error log, you'll need to build from source:
```
wget https://openresty.org/download/openresty-1.17.8.1rc1.tar.gz
tar xzf openresty-1.17.8.1rc1.tar.gz
cd openresty-1.17.8.1rc1
./configure
make
sudo make install
```

Now, we install Redis. And since we run another instance already on the example server, we change the port from 6379 to 6380
```
wget http://download.redis.io/redis-stable.tar.gz
tar xvzf redis-stable.tar.gz
cd redis-stable
make
make install

cp redis.conf /etc/
nano /etc/redis.conf and change daemonize to "yes" and comment out bind address 127.0.0.1

redis-server /etc/redis.conf

semanage port -a -t redis_port_t -p tcp 6380
```

## Configuration - single server
The NGINX configuration example below is based on:
- A wildcard SSL certificate, in this example from GoDaddy
- Serving master from example.com and www.example.com
- Serving PRs/branches as subdomains
- GitHub callback pointing to github-webhook.example.com

```
user  nginx;
worker_processes  1;

events {
    worker_connections  1024;
}

http {
    include       mime.types;
    default_type  application/octet-stream;

    # Make sure openresty is installed first. We don't use thier nginx, but the lua-libs
    lua_package_path "/usr/local/openresty/lualib/?.lua;;";

    # See https://github.com/leev/ngx_http_geoip2_module for examples
    geoip2 /etc/nginx/GeoIP2-Country.mmdb {
        auto_reload 5m;
        $geoip2_data_country_code default=US source=$remote_addr country iso_code;
    }

    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_origin"';

    access_log  /var/log/nginx/access-test.log  main;

    sendfile       on;
    tcp_nopush     on;

    keepalive_timeout  65;

    gzip  on;

    # HTTP to HTTPS redirect in ALL cases
    server {
        listen 80;
        return 301 https://$host$request_uri;
    }

    # The main/master instance that lives on example.com www.example.com
    server {
        listen 443 ssl http2;

        server_name example.com www.example.com;
        ssl_certificate     /etc/nginx/ssl/example.com.crt;
        ssl_certificate_key /etc/nginx/ssl/example.com.key;

        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_prefer_server_ciphers on;
        ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;
        ssl_dhparam /etc/nginx/dhparam.pem; # openssl dhparam -out /etc/nginx/dhparam.pem 4096

        ssl_stapling on;
        ssl_stapling_verify on;
        ssl_trusted_certificate /etc/nginx/ssl/gd_bundle-g2-g1.crt;
        resolver 1.1.1.1 1.0.0.1 8.8.8.8 8.8.4.4 valid=60s;

        ssl_session_timeout  10m;
        ssl_session_cache shared:SSL:10m;
        ssl_session_tickets on;

        location / {
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Country-Code $geoip2_data_country_code;
            proxy_pass http://127.0.0.1:3001;
            proxy_redirect off;
            proxy_set_header X-Forwarded-Proto $scheme;

            add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
            add_header X-Content-Type-Options "nosniff" always;
            add_header X-Frame-Options SAMEORIGIN always;
            add_header X-XSS-Protection "1; mode=block" always;
        }
    }

    # GitHub Webhook instance
    server {
        listen 443 ssl http2;

        server_name github-webhook.example.com;
        ssl_certificate     /etc/nginx/ssl/example.com.crt;
        ssl_certificate_key /etc/nginx/ssl/example.com.key;

        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_prefer_server_ciphers on;
        ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;
        ssl_dhparam /etc/nginx/dhparam.pem; # openssl dhparam -out /etc/nginx/dhparam.pem 4096

        ssl_stapling on;
        ssl_stapling_verify on;
        ssl_trusted_certificate /etc/nginx/ssl/gd_bundle-g2-g1.crt;
        resolver 1.1.1.1 1.0.0.1 8.8.8.8 8.8.4.4 valid=60s;

        ssl_session_timeout  10m;
        ssl_session_cache shared:SSL:10m;
        ssl_session_tickets on;

        location / {
            proxy_set_header X-Real-IP $remote_addr;
            proxy_pass http://127.0.0.1:3000;
        }
    }

    # The wildcard instances *.example.com
    server {
        listen 443 ssl http2;

        # Since lua lacks full regexs, this is easier than splitting host in lua..
        server_name ~([^.]+)\.example\.com$;
        set $subdomain $1;

        ssl_certificate     /etc/nginx/ssl/example.com.crt;
        ssl_certificate_key /etc/nginx/ssl/example.com.key;

        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_prefer_server_ciphers on;
        ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;
        ssl_dhparam /etc/nginx/dhparam.pem; # openssl dhparam -out /etc/nginx/dhparam.pem 4096

        ssl_stapling on;
        ssl_stapling_verify on;
        ssl_trusted_certificate /etc/nginx/ssl/gd_bundle-g2-g1.crt;
        resolver 1.1.1.1 1.0.0.1 8.8.8.8 8.8.4.4 valid=60s;

        ssl_session_timeout  10m;
        ssl_session_cache shared:SSL:10m;
        ssl_session_tickets on;

        # To avoid having wildcard instances crawled we add basic HTTP AUTH
        auth_basic "show-me-your-work";
        auth_basic_user_file /etc/nginx/.htpasswd;

        location / {
           set $branchPort '';

           access_by_lua '
                local branch = ngx.var.subdomain
                if not branch then
                    ngx.log(ngx.ERR, "no subdomain found")
                    return ngx.exit(400)
                end

                local redis = require "resty.redis"
                local red = redis:new()

                red:set_timeout(1000)

                local ok, err = red:connect("127.0.0.1", 6380)
                if not ok then
                    ngx.log(ngx.ERR, "failed to connect to redis: ", err)
                    return ngx.exit(500)
                end

                local port, err = red:get(branch)
                if not port then
                    ngx.log(ngx.ERR, "failed to get redis key: ", err)
                    return ngx.exit(500)
                end

                if port == ngx.null then
                    ngx.log(ngx.ERR, "no port found for branch ", branch)
                    return ngx.exit(400)
                end

                ngx.var.branchPort = port
            ';

            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Country-Code $geoip2_data_country_code;
            proxy_pass http://127.0.0.1:$branchPort;
            proxy_redirect off;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options SAMEORIGIN always;
        add_header X-XSS-Protection "1; mode=block" always;
    }
}
```

The reason that we put all PRs/branches behind a HTTP basic auth is not primarily security. It's important to keep searchengines out: https://searchengineland.com/how-to-keep-staging-development-site-index-286987

## Starting Redis in Docker for testing
1. Run `docker-compose up`
2. To add enties manually you can run `docker run -it --network show-me-your-work_redis --rm redis:alpine redis-cli -h redis`

## Config file example
```json
{
    "startFile": "./src/server/index.js", // The file for PM2 to run
    "pre": [ // Commands to run before starting/restarting the service
        "npm run build:stage"
    ],
    "env": {
        "NODE_ENV": "stage",
        "REDIS_HOST": "10.20.7.105",
        "REDIS_PORT": "6379"
    }
}

```

