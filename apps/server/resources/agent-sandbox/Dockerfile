FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS node
FROM python:3.14-slim-bookworm@sha256:48b13b003dda20b16f9442b8475aa05fe21bf6579a8c881db92ffb4d8fd20f83 AS guest

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git openssl libatomic1 libfuse2 poppler-utils fonts-dejavu-core busybox-static util-linux iproute2 nftables \
    linux-image-cloud-$(dpkg --print-architecture) \
    && sed -i 's|^mozilla/emSign_ECC_Root_CA_-_G3.crt$|!mozilla/emSign_ECC_Root_CA_-_G3.crt|' /etc/ca-certificates.conf \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY bootstrap-pip.py /opt/legalwork/bootstrap-pip.py
RUN python3 -I -S /opt/legalwork/bootstrap-pip.py --seed \
    && rm /opt/legalwork/bootstrap-pip.py
COPY requirements.txt /opt/legalwork/requirements.txt
RUN pip install --no-cache-dir -r /opt/legalwork/requirements.txt \
    && pip freeze > /opt/legalwork/python-packages.txt
COPY test_pypdf.py /opt/legalwork/test_pypdf.py
RUN python3 -B /opt/legalwork/test_pypdf.py && rm /opt/legalwork/test_pypdf.py
COPY relay.py supervisor.py network.py protocol.py /opt/legalwork/
COPY filesystem.py /opt/legalwork/filesystem.py
COPY test_relay.py /opt/legalwork/test_relay.py
RUN python3 -B /opt/legalwork/test_relay.py && rm /opt/legalwork/test_relay.py
COPY init /init
RUN chmod 0555 /opt/legalwork /opt/legalwork/relay.py
RUN chmod 0755 /init && mkdir -p /proc /sys /dev /run /mnt/approved && rm -rf /workspace /authorized /skills && ln -s /mnt/approved/workspace /workspace && ln -s /mnt/approved/authorized /authorized && ln -s /mnt/approved/skills /skills
RUN dpkg-query -W -f='${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n' > /opt/legalwork/guest-packages.tsv
WORKDIR /

# Docker is a build-time tool on CI, never an end-user dependency.
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS pack
RUN apt-get update && apt-get install -y --no-install-recommends cpio gzip && rm -rf /var/lib/apt/lists/*
COPY --from=guest / /rootfs
RUN mkdir /out && cp /rootfs/boot/vmlinuz-* /out/kernel && rm -rf /rootfs/boot /rootfs/var/cache /rootfs/var/lib/apt/lists
RUN cp /rootfs/opt/legalwork/guest-packages.tsv /out/guest-packages.tsv
RUN cp /rootfs/opt/legalwork/python-packages.txt /out/python-packages.txt
RUN printf "nameserver 10.0.2.3\noptions timeout:1 attempts:1\n" > /rootfs/etc/resolv.conf
WORKDIR /rootfs
RUN find . -print0 | cpio --null -o -H newc | gzip -1 > /out/initrd.gz
