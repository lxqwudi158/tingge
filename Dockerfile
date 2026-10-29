FROM node:20-alpine

# 云端部署：不带本地 NCM（换链走公共音源），Render 会把 PORT 注入为 10000
ENV NODE_ENV=production \
    PORT=10000 \
    NO_NCM=1

WORKDIR /app
COPY index.html server.js ./

EXPOSE 10000
CMD ["node", "server.js"]
