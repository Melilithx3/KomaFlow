# Copied from reference/bench/bench/worker/adapters/lama_arch.py (verified with mayocream/lama-manga).
"""Big-LaMa FFCResNetGenerator.

Перенесено из https://github.com/advimman/lama
(saicinpainting/training/modules/ffc.py, Apache License 2.0, (c) Samsung AI Center),
оставлены только ветки, используемые конфигурацией big-lama:
  init_conv_kwargs   {ratio_gin: 0, ratio_gout: 0, enable_lfu: false}
  downsample_conv_kwargs {ratio_gin: 0, ratio_gout: 0, enable_lfu: false}
  resnet_conv_kwargs {ratio_gin: 0.75, ratio_gout: 0.75, enable_lfu: false}
  add_out_act: sigmoid
Имена модулей совпадают с оригиналом, поэтому веса mayocream/lama-manga
загружаются через load_state_dict(strict=True) без каких-либо преобразований.
"""
from __future__ import annotations

import torch
import torch.nn as nn


class FourierUnit(nn.Module):
    def __init__(self, in_channels, out_channels, groups=1, fft_norm="ortho"):
        super().__init__()
        self.groups = groups
        self.conv_layer = nn.Conv2d(in_channels * 2, out_channels * 2, kernel_size=1, stride=1, padding=0,
                                    groups=groups, bias=False)
        self.bn = nn.BatchNorm2d(out_channels * 2)
        self.relu = nn.ReLU(inplace=True)
        self.fft_norm = fft_norm

    def forward(self, x):
        batch = x.shape[0]
        in_dtype = x.dtype
        fft_dim = (-2, -1)
        ffted = torch.fft.rfftn(x.float(), dim=fft_dim, norm=self.fft_norm)
        ffted = torch.stack((ffted.real, ffted.imag), dim=-1)
        ffted = ffted.permute(0, 1, 4, 2, 3).contiguous()
        ffted = ffted.view((batch, -1) + ffted.size()[3:]).to(in_dtype)
        ffted = self.relu(self.bn(self.conv_layer(ffted)))
        ffted = ffted.view((batch, -1, 2) + ffted.size()[2:]).permute(0, 1, 3, 4, 2).contiguous().float()
        ffted = torch.complex(ffted[..., 0], ffted[..., 1])
        out = torch.fft.irfftn(ffted, s=x.shape[-2:], dim=fft_dim, norm=self.fft_norm)
        return out.to(in_dtype)


class SpectralTransform(nn.Module):
    def __init__(self, in_channels, out_channels, stride=1, groups=1, enable_lfu=False):
        super().__init__()
        assert not enable_lfu, "big-lama не использует LFU"
        self.downsample = nn.AvgPool2d(kernel_size=(2, 2), stride=2) if stride == 2 else nn.Identity()
        self.conv1 = nn.Sequential(
            nn.Conv2d(in_channels, out_channels // 2, kernel_size=1, groups=groups, bias=False),
            nn.BatchNorm2d(out_channels // 2),
            nn.ReLU(inplace=True),
        )
        self.fu = FourierUnit(out_channels // 2, out_channels // 2, groups)
        self.conv2 = nn.Conv2d(out_channels // 2, out_channels, kernel_size=1, groups=groups, bias=False)

    def forward(self, x):
        x = self.conv1(self.downsample(x))
        return self.conv2(x + self.fu(x))


class FFC(nn.Module):
    def __init__(self, in_channels, out_channels, kernel_size, ratio_gin, ratio_gout, stride=1, padding=0,
                 dilation=1, groups=1, bias=False, enable_lfu=False, padding_type="reflect"):
        super().__init__()
        in_cg = int(in_channels * ratio_gin)
        in_cl = in_channels - in_cg
        out_cg = int(out_channels * ratio_gout)
        out_cl = out_channels - out_cg
        self.ratio_gin = ratio_gin
        self.ratio_gout = ratio_gout

        def conv(cin, cout):
            if cin == 0 or cout == 0:
                return nn.Identity()
            return nn.Conv2d(cin, cout, kernel_size, stride, padding, dilation, groups, bias, padding_mode=padding_type)

        self.convl2l = conv(in_cl, out_cl)
        self.convl2g = conv(in_cl, out_cg)
        self.convg2l = conv(in_cg, out_cl)
        self.convg2g = (nn.Identity() if in_cg == 0 or out_cg == 0
                        else SpectralTransform(in_cg, out_cg, stride, 1 if groups == 1 else groups // 2, enable_lfu))

    def forward(self, x):
        x_l, x_g = x if type(x) is tuple else (x, 0)
        out_xl, out_xg = 0, 0
        if self.ratio_gout != 1:
            out_xl = self.convl2l(x_l) + self.convg2l(x_g)
        if self.ratio_gout != 0:
            out_xg = self.convl2g(x_l) + self.convg2g(x_g)
        return out_xl, out_xg


class FFC_BN_ACT(nn.Module):
    def __init__(self, in_channels, out_channels, kernel_size, ratio_gin, ratio_gout, stride=1, padding=0,
                 dilation=1, groups=1, bias=False, norm_layer=nn.BatchNorm2d, activation_layer=nn.Identity,
                 padding_type="reflect", enable_lfu=False):
        super().__init__()
        self.ffc = FFC(in_channels, out_channels, kernel_size, ratio_gin, ratio_gout, stride, padding, dilation,
                       groups, bias, enable_lfu, padding_type=padding_type)
        lnorm = nn.Identity if ratio_gout == 1 else norm_layer
        gnorm = nn.Identity if ratio_gout == 0 else norm_layer
        global_channels = int(out_channels * ratio_gout)
        self.bn_l = lnorm(out_channels - global_channels)
        self.bn_g = gnorm(global_channels)
        lact = nn.Identity if ratio_gout == 1 else activation_layer
        gact = nn.Identity if ratio_gout == 0 else activation_layer
        self.act_l = lact(inplace=True)
        self.act_g = gact(inplace=True)

    def forward(self, x):
        x_l, x_g = self.ffc(x)
        return self.act_l(self.bn_l(x_l)), self.act_g(self.bn_g(x_g))


class FFCResnetBlock(nn.Module):
    def __init__(self, dim, padding_type, norm_layer, activation_layer=nn.ReLU, dilation=1, **conv_kwargs):
        super().__init__()
        self.conv1 = FFC_BN_ACT(dim, dim, kernel_size=3, padding=dilation, dilation=dilation, norm_layer=norm_layer,
                                activation_layer=activation_layer, padding_type=padding_type, **conv_kwargs)
        self.conv2 = FFC_BN_ACT(dim, dim, kernel_size=3, padding=dilation, dilation=dilation, norm_layer=norm_layer,
                                activation_layer=activation_layer, padding_type=padding_type, **conv_kwargs)

    def forward(self, x):
        x_l, x_g = x if type(x) is tuple else (x, 0)
        id_l, id_g = x_l, x_g
        x_l, x_g = self.conv1((x_l, x_g))
        x_l, x_g = self.conv2((x_l, x_g))
        return id_l + x_l, id_g + x_g


class ConcatTupleLayer(nn.Module):
    def forward(self, x):
        x_l, x_g = x
        if not torch.is_tensor(x_g):
            return x_l
        return torch.cat(x, dim=1)


class FFCResNetGenerator(nn.Module):
    def __init__(self, input_nc=4, output_nc=3, ngf=64, n_downsampling=3, n_blocks=18, max_features=1024):
        super().__init__()
        norm_layer = nn.BatchNorm2d
        act = nn.ReLU
        init_kw = dict(ratio_gin=0, ratio_gout=0, enable_lfu=False)
        down_kw = dict(ratio_gin=0, ratio_gout=0, enable_lfu=False)
        res_kw = dict(ratio_gin=0.75, ratio_gout=0.75, enable_lfu=False)

        model: list[nn.Module] = [nn.ReflectionPad2d(3),
                                  FFC_BN_ACT(input_nc, ngf, kernel_size=7, padding=0, norm_layer=norm_layer,
                                             activation_layer=act, **init_kw)]
        for i in range(n_downsampling):
            mult = 2 ** i
            kw = dict(down_kw)
            if i == n_downsampling - 1:
                kw["ratio_gout"] = res_kw["ratio_gin"]
            model.append(FFC_BN_ACT(min(max_features, ngf * mult), min(max_features, ngf * mult * 2), kernel_size=3,
                                    stride=2, padding=1, norm_layer=norm_layer, activation_layer=act, **kw))
        feats = min(max_features, ngf * 2 ** n_downsampling)
        for _ in range(n_blocks):
            model.append(FFCResnetBlock(feats, padding_type="reflect", activation_layer=act, norm_layer=norm_layer,
                                        **res_kw))
        model.append(ConcatTupleLayer())
        for i in range(n_downsampling):
            mult = 2 ** (n_downsampling - i)
            model += [nn.ConvTranspose2d(min(max_features, ngf * mult), min(max_features, int(ngf * mult / 2)),
                                         kernel_size=3, stride=2, padding=1, output_padding=1),
                      nn.BatchNorm2d(min(max_features, int(ngf * mult / 2))),
                      nn.ReLU(True)]
        model += [nn.ReflectionPad2d(3), nn.Conv2d(ngf, output_nc, kernel_size=7, padding=0), nn.Sigmoid()]
        self.model = nn.Sequential(*model)

    def forward(self, x):
        return self.model(x)
