FROM node:10.14-alpine

RUN apk update && \
	apk upgrade && \
	apk add git && \
	apk add vim

RUN npm install -g nodemon

VOLUME /srv

EXPOSE 8007
ADD run.sh /
CMD /run.sh
