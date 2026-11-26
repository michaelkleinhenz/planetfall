#!/bin/bash
gcc -m32 -o mkt mkt.c
cp ../last/tmpguild.text magic.tmp
./mkt magic
mv msginfo.i ../last

