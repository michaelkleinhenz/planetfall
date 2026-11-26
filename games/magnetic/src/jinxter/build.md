# How to build Jinxter

# prerequisites:

Be sure the tools are built and installed into `../src/tools/bin`

## Fred the Data

(from jinxter dir)
```
cd last
bfred.bat
```

This will re-generate all the Fred output files. Currently these are already present in the `last` directory as they are checked into git. At some point we might remove those from source control.

Fredding the data also generates `last/tmpguild.text` which is all the text from the Fred object data.


## Building the text

(from jinxter dir)
```
cd ./text
b.sh
```

Text for jinxter is not complicated, `b.sh` simply runs a utility to copy the other text portions together with `tmpguild.text` to make `magic.text`.

`magic.text` is the master text file (corresponding to, but not the same format as the `.msg` text file). Originally, `magic.text` would have been compressed. We don't bother with that anymore.

**Additionally** the build util, creates `msginfo.i` which is a small fragment of equates needed as part of the code assembly. This file is copied up to `../last`

## Building the Code

(from jinxter dir)
```
cd obj
make
```

`equates.i` is not generated like guild.

If it works, the assembly in `../last` and `../../newcommonlast` is built into `.o` then linked into `prog`.

Notes: (from guild dir)


## Running

Not done yet. i need to get the original emulator to work.


  












