FROM node:24-alpine

ARG GIT_COMMIT_SHA
ENV GIT_COMMIT_SHA=${GIT_COMMIT_SHA}

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY dedicated.mjs ./dedicated.mjs
COPY source ./source
COPY public ./public
COPY data ./data

RUN sed -i -E "s/version = '([^+]+)\\+dev'/version = '\\1+$GIT_COMMIT_SHA'/" ./source/engine/common/Def.mjs

EXPOSE 3000

CMD ["npm", "start"]
