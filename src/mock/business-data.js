const LXM_SVG = (title, sub, a = "#FF6B6B", b = "#8B5E3C") => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480"><defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="720" height="480" fill="url(#g)"/><circle cx="615" cy="88" r="82" fill="rgba(255,255,255,.15)"/><text x="46" y="220" font-size="44" fill="white" font-family="Microsoft YaHei,Arial">${title}</text><text x="48" y="278" font-size="23" fill="white" opacity=".9" font-family="Microsoft YaHei,Arial">${sub}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

window.LXM_DATA = {
  cities: [
    {
      id: "city1",
      name: "长沙",
      mode: "直营",
      status: "运营中"
    }
  ],
  distributors: [
    {
      id: "dist1",
      name: "长沙直营拓展组",
      contact: "直营BD",
      phone: "13700000001",
      commissionRate: 0,
      settlementCycle: "月结",
      status: "启用"
    },
    {
      id: "dist2",
      name: "长沙高校推广组",
      contact: "校园BD",
      phone: "13700000002",
      commissionRate: 8,
      settlementCycle: "月结",
      status: "启用"
    }
  ],
  shops: [
    {
      id: "shop1",
      name: "鹿山咖啡",
      logo: "鹿",
      city: "长沙",
      district: "岳麓区",
      shopId: "SHOP001",
      distributorIds: ["dist1"],
      distributorRates: { dist1: 5 },
      scene: "门店台卡",
      qrPosition: "收银台",
      commissionRate: 10,
      shareRatio: 10,
      settlementCycle: "月结",
      account: "shop_lushan",
      password: "123456",
      contact: "周店长",
      phone: "13800001111",
      address: "岳麓山南门 18 号",
      status: "合作中"
    },
    {
      id: "shop2",
      name: "云栖花园",
      logo: "云",
      city: "长沙",
      district: "开福区",
      shopId: "SHOP002",
      distributorIds: ["dist1", "dist2"],
      distributorRates: { dist1: 5, dist2: 8 },
      scene: "桌贴二维码",
      qrPosition: "靠窗区",
      commissionRate: 12,
      shareRatio: 12,
      settlementCycle: "月结",
      account: "shop_yunqi",
      password: "123456",
      contact: "张经理",
      phone: "13800002222",
      address: "湘江北路 99 号",
      status: "合作中"
    },
    {
      id: "shop3",
      name: "复古书屋",
      logo: "书",
      city: "长沙",
      district: "天心区",
      shopId: "SHOP003",
      distributorIds: [],
      distributorRates: {},
      scene: "海报二维码",
      qrPosition: "前台海报",
      commissionRate: 15,
      shareRatio: 15,
      settlementCycle: "周结",
      account: "shop_book",
      password: "123456",
      contact: "李老板",
      phone: "13800003333",
      address: "太平街 21 号",
      status: "合作中"
    }
  ],
  staff: [
    {
      id: "st1",
      name: "鹿小鸣主理人",
      account: "admin",
      password: "admin123",
      phone: "13800000001",
      role: "super",
      status: "启用",
      city: "全国",
      permissions: [
        "*"
      ]
    },
    {
      id: "st2",
      name: "客服小林",
      account: "service_xl",
      password: "123456",
      phone: "17700000002",
      role: "service",
      status: "启用",
      city: "长沙",
      permissions: [
        "orderEdit",
        "assign",
        "cancelOrder"
      ]
    },
    {
      id: "st3",
      name: "客服阿宁",
      account: "service_an",
      password: "123456",
      phone: "17700000003",
      role: "service",
      status: "启用",
      city: "长沙",
      permissions: [
        "orderEdit",
        "assign"
      ]
    },
    {
      id: "st4",
      name: "摄影师阿南",
      account: "photo_an",
      password: "123456",
      phone: "15200000004",
      role: "photo",
      commissionRate: 20,
      status: "启用",
      city: "长沙",
      permissions: [
        "shootUpdate"
      ]
    },
    {
      id: "st6",
      name: "内容运营安安",
      account: "content_aa",
      password: "123456",
      phone: "16600000006",
      role: "content",
      status: "启用",
      city: "全国",
      permissions: [
        "contentEdit"
      ]
    },
    {
      id: "st9",
      name: "财务小鹿",
      account: "finance_lu",
      password: "123456",
      phone: "15500000009",
      role: "finance",
      status: "启用",
      city: "全国",
      permissions: [
        "financeReview",
        "export"
      ]
    }
  ],
  spots: [
    {
      id: "spot1",
      name: "城市花园打卡点",
      city: "长沙",
      tag: "热门",
      hotScore: 96,
      sort: 1,
      intro: "适合清新、情侣、午后自然光旅拍。",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%9F%8E%E5%B8%82%E8%8A%B1%E5%9B%AD%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E9%95%BF%E6%B2%99%E7%83%AD%E9%97%A8%E6%89%93%E5%8D%A1%E7%82%B9%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "spot2",
      name: "复古街区打卡点",
      city: "长沙",
      tag: "爆款",
      hotScore: 92,
      sort: 2,
      intro: "街头、胶片、松弛感城市旅拍。",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%A4%8D%E5%8F%A4%E8%A1%97%E5%8C%BA%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%9F%8E%E5%B8%82%E8%A1%97%E6%8B%8D%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "spot3",
      name: "文艺书店打卡点",
      city: "长沙",
      tag: "推荐",
      hotScore: 88,
      sort: 3,
      intro: "安静、人文、复古室内。",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%96%87%E8%89%BA%E4%B9%A6%E5%BA%97%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%AE%89%E9%9D%99%E4%BA%BA%E6%96%87%3C%2Ftext%3E%3C%2Fsvg%3E"
    }
  ],
  series: [
    {
      id: "ser1",
      spotId: "spot1",
      spotIds: [
        "spot1"
      ],
      name: "春日清新系列",
      intro: "明亮自然光，适合情侣与闺蜜。",
      style: "清新",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%98%A5%E6%97%A5%E6%B8%85%E6%96%B0%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E7%B3%BB%E5%88%97%E9%A6%96%E9%A1%B5%E5%9B%BE%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "ser2",
      spotId: "spot1",
      spotIds: [
        "spot1",
        "spot2"
      ],
      name: "复古胶片系列",
      intro: "偏暖色调，温暖克制。",
      style: "复古",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%A4%8D%E5%8F%A4%E8%83%B6%E7%89%87%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E7%B3%BB%E5%88%97%E9%A6%96%E9%A1%B5%E5%9B%BE%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "ser3",
      spotId: "spot2",
      spotIds: [
        "spot2"
      ],
      name: "街头松弛系列",
      intro: "街拍感、松弛感、轻叙事。",
      style: "街拍",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E8%A1%97%E5%A4%B4%E6%9D%BE%E5%BC%9B%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E7%B3%BB%E5%88%97%E9%A6%96%E9%A1%B5%E5%9B%BE%3C%2Ftext%3E%3C%2Fsvg%3E"
    }
  ],
  albums: [
    {
      id: "alb1",
      spotId: "spot1",
      seriesId: "ser1",
      name: "春日花园照片单品",
      price: 699,
      photoIds: [
        "sample1",
        "sample6",
        "sample11"
      ],
      intro: "清透明亮，12 张样片。",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%98%A5%E6%97%A5%E8%8A%B1%E5%9B%AD%E5%90%88%E9%9B%86%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E12%20%E5%BC%A0%E6%A0%B7%E7%89%87%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "alb2",
      spotId: "spot1",
      seriesId: "ser2",
      name: "胶片复古照片单品",
      price: 799,
      photoIds: [
        "sample2",
        "sample7",
        "sample12"
      ],
      intro: "暖色胶片，16 张样片。",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E8%83%B6%E7%89%87%E5%A4%8D%E5%8F%A4%E5%90%88%E9%9B%86%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E16%20%E5%BC%A0%E6%A0%B7%E7%89%87%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "alb3",
      spotId: "spot2",
      seriesId: "ser3",
      name: "街区慵懒照片单品",
      price: 759,
      photoIds: [
        "sample3",
        "sample8",
        "sample13"
      ],
      intro: "街头松弛感，10 张样片。",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E8%A1%97%E5%8C%BA%E6%85%B5%E6%87%92%E5%90%88%E9%9B%86%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E10%20%E5%BC%A0%E6%A0%B7%E7%89%87%3C%2Ftext%3E%3C%2Fsvg%3E"
    }
  ],
  samples: [
    {
      id: "sample1",
      name: "样片 1",
      type: "photo",
      albumId: "alb1",
      seriesId: "ser1",
      spotId: "spot1",
      isShowcase: true,
      url: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%236CA6C1%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23567568%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%A0%B7%E7%89%87%201%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%8F%8C%E5%87%BB%E6%94%BE%E5%A4%A7%E9%A2%84%E8%A7%88%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "sample2",
      name: "样片 2",
      type: "photo",
      albumId: "alb2",
      seriesId: "ser2",
      spotId: "spot2",
      isShowcase: true,
      url: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%A0%B7%E7%89%87%202%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%8F%8C%E5%87%BB%E6%94%BE%E5%A4%A7%E9%A2%84%E8%A7%88%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "sample3",
      name: "样片 3",
      type: "photo",
      albumId: "alb3",
      seriesId: "ser3",
      spotId: "spot3",
      isShowcase: true,
      url: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%236CA6C1%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%A0%B7%E7%89%87%203%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%8F%8C%E5%87%BB%E6%94%BE%E5%A4%A7%E9%A2%84%E8%A7%88%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "sample6",
      name: "样片 6",
      type: "photo",
      albumId: "alb1",
      seriesId: "ser1",
      spotId: "spot1",
      isShowcase: true,
      url: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%A0%B7%E7%89%87%206%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%8F%8C%E5%87%BB%E6%94%BE%E5%A4%A7%E9%A2%84%E8%A7%88%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "sample7",
      name: "样片 7",
      type: "photo",
      albumId: "alb2",
      seriesId: "ser2",
      spotId: "spot2",
      isShowcase: true,
      url: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%236CA6C1%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23567568%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%A0%B7%E7%89%87%207%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%8F%8C%E5%87%BB%E6%94%BE%E5%A4%A7%E9%A2%84%E8%A7%88%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "sample8",
      name: "样片 8",
      type: "photo",
      albumId: "alb3",
      seriesId: "ser3",
      spotId: "spot3",
      isShowcase: true,
      url: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%A0%B7%E7%89%87%208%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%8F%8C%E5%87%BB%E6%94%BE%E5%A4%A7%E9%A2%84%E8%A7%88%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "sample11",
      name: "样片 11",
      type: "photo",
      albumId: "alb1",
      seriesId: "ser1",
      spotId: "spot1",
      isShowcase: false,
      url: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%236CA6C1%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%A0%B7%E7%89%87%2011%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%8F%8C%E5%87%BB%E6%94%BE%E5%A4%A7%E9%A2%84%E8%A7%88%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "sample12",
      name: "样片 12",
      type: "photo",
      albumId: "alb2",
      seriesId: "ser2",
      spotId: "spot2",
      isShowcase: false,
      url: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%A0%B7%E7%89%87%2012%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%8F%8C%E5%87%BB%E6%94%BE%E5%A4%A7%E9%A2%84%E8%A7%88%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "sample13",
      name: "样片 13",
      type: "photo",
      albumId: "alb3",
      seriesId: "ser3",
      spotId: "spot3",
      isShowcase: false,
      url: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%236CA6C1%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23567568%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%A0%B7%E7%89%87%2013%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%8F%8C%E5%87%BB%E6%94%BE%E5%A4%A7%E9%A2%84%E8%A7%88%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "sample16",
      name: "样片 16",
      type: "photo",
      albumId: "alb1",
      seriesId: "ser1",
      spotId: "spot1",
      isShowcase: false,
      url: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23567568%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%A0%B7%E7%89%87%2016%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%8F%8C%E5%87%BB%E6%94%BE%E5%A4%A7%E9%A2%84%E8%A7%88%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "sample17",
      name: "样片 17",
      type: "photo",
      albumId: "alb2",
      seriesId: "ser2",
      spotId: "spot2",
      isShowcase: false,
      url: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%236CA6C1%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%A0%B7%E7%89%87%2017%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%8F%8C%E5%87%BB%E6%94%BE%E5%A4%A7%E9%A2%84%E8%A7%88%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "sample18",
      name: "样片 18",
      type: "photo",
      albumId: "alb3",
      seriesId: "ser3",
      spotId: "spot3",
      isShowcase: false,
      url: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%A0%B7%E7%89%87%2018%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%8F%8C%E5%87%BB%E6%94%BE%E5%A4%A7%E9%A2%84%E8%A7%88%3C%2Ftext%3E%3C%2Fsvg%3E"
    }
  ],
  packages: [
    {
      id: "pkg1",
      spotId: "spot1",
      seriesId: "ser1",
      albumId: "alb1",
      name: "花园双人拍摄套餐",
      type: "photo",
      originalPrice: 899,
      price: 699,
      specialPrice: 699,
      isMainPush: false,
      mainPush: false,
      isShow: true,
      status: "上架",
      serviceTags: [
        "精修9张",
        "拍摄45分钟",
        "1套服装"
      ],
      tags: [
        "精修9张",
        "45分钟",
        "1套服装"
      ],
      intro: "适合情侣、闺蜜，含基础妆造建议。",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E8%8A%B1%E5%9B%AD%E5%8F%8C%E4%BA%BA%E5%A5%97%E9%A4%90%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%89%93%E5%8D%A1%E7%82%B9%E5%A5%97%E9%A4%90%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "pkg2",
      spotId: "spot1",
      seriesId: "ser2",
      albumId: "alb2",
      name: "胶片氛围套餐",
      type: "photo",
      originalPrice: 1099,
      price: 899,
      specialPrice: 899,
      isMainPush: false,
      mainPush: false,
      isShow: true,
      status: "上架",
      serviceTags: [
        "精修12张",
        "拍摄60分钟",
        "服装建议"
      ],
      tags: [
        "精修12张",
        "60分钟"
      ],
      intro: "复古胶片色，适合街区与花园。",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E8%83%B6%E7%89%87%E6%B0%9B%E5%9B%B4%E5%A5%97%E9%A4%90%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%89%93%E5%8D%A1%E7%82%B9%E5%A5%97%E9%A4%90%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "pkg3",
      spotId: "spot2",
      seriesId: "ser3",
      albumId: "alb3",
      name: "街区短视频",
      type: "video",
      originalPrice: 1399,
      price: 1199,
      specialPrice: 1199,
      isMainPush: false,
      mainPush: false,
      isShow: true,
      status: "上架",
      serviceTags: [
        "竖屏成片1条",
        "含剪辑",
        "拍摄60分钟"
      ],
      tags: [
        "短视频",
        "含剪辑"
      ],
      intro: "适合小红书、抖音竖屏成片。",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E8%A1%97%E5%8C%BA%E7%9F%AD%E8%A7%86%E9%A2%91%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E7%9F%AD%E8%A7%86%E9%A2%91%E4%BA%A7%E5%93%81%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "pkg4",
      spotId: "",
      seriesId: "",
      albumId: "",
      name: "全局主推照片套餐",
      type: "photo",
      originalPrice: 1599,
      price: 1299,
      specialPrice: 1299,
      isMainPush: true,
      mainPush: true,
      isShow: true,
      status: "上架",
      serviceTags: [
        "全打卡点展示",
        "精修18张",
        "拍摄90分钟"
      ],
      tags: [
        "主推套餐",
        "全打卡点展示"
      ],
      intro: "跨所有打卡点展示，首页和所有系列详情页均可见。",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%85%A8%E5%B1%80%E4%B8%BB%E6%8E%A8%E5%A5%97%E9%A4%90%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%89%80%E6%9C%89%E6%89%93%E5%8D%A1%E7%82%B9%E5%B1%95%E7%A4%BA%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
  { id: "vs1", spotId: "spot1", seriesId: "ser1", albumId: "", name: "杜甫江阁湘江夜景短片", title: "杜甫江阁湘江夜景短片", type: "video", isVideoSingle: true, productKind: "video_single", originalPrice: 299, price: 299, specialPrice: 299, isMainPush: true, mainPush: true, isShow: true, status: "上架", durationText: "60秒", previewVideoUrl: "", videoUrl: "", tags: ["夜景", "湘江", "城市"], intro: "杜甫江阁夜景航拍+延时，成片质感。", cover: LXM_SVG("短视频", "杜甫江阁") },
  { id: "vs2", spotId: "spot2", seriesId: "ser3", albumId: "", name: "IFS城市高光短片", title: "IFS城市高光短片", type: "video", isVideoSingle: true, productKind: "video_single", originalPrice: 269, price: 269, specialPrice: 269, isMainPush: false, mainPush: false, isShow: true, status: "上架", durationText: "45秒", previewVideoUrl: "", videoUrl: "", tags: ["街拍", "商圈"], intro: "IFS国金中心潮流街拍。", cover: LXM_SVG("短视频", "IFS") },
  { id: "vs3", spotId: "spot2", seriesId: "ser1", albumId: "", name: "橘子洲落日江景短片", title: "橘子洲落日江景短片", type: "video", isVideoSingle: true, productKind: "video_single", originalPrice: 329, price: 329, specialPrice: 329, isMainPush: false, mainPush: false, isShow: true, status: "上架", durationText: "45秒", previewVideoUrl: "", videoUrl: "", tags: ["落日", "江景"], intro: "橘子洲头落日江景。", cover: LXM_SVG("短视频", "橘子洲") },
  { id: "vs4", spotId: "spot2", seriesId: "ser2", albumId: "", name: "太平老街复古漫游短片", title: "太平老街复古漫游短片", type: "video", isVideoSingle: true, productKind: "video_single", originalPrice: 319, price: 319, specialPrice: 319, isMainPush: false, mainPush: false, isShow: false, status: "下架", durationText: "50秒", previewVideoUrl: "", videoUrl: "", tags: ["复古", "老街"], intro: "太平老街胶片质感漫游。", cover: LXM_SVG("短视频", "太平老街") },
  { id: "vs5", spotId: "spot1", seriesId: "ser3", albumId: "", name: "黄兴路夜景短视频路线", title: "黄兴路夜景短视频路线", type: "video", isVideoSingle: true, productKind: "video_single", originalPrice: 279, price: 279, specialPrice: 279, isMainPush: false, mainPush: false, isShow: false, status: "草稿", durationText: "60秒", previewVideoUrl: "", videoUrl: "", tags: ["夜景", "步行街"], intro: "黄兴路步行街霓虹夜景。", cover: LXM_SVG("短视频", "黄兴路") },
  { id: "vs6", spotId: "spot1", seriesId: "ser2", albumId: "", name: "闺蜜夜游长沙短片", title: "闺蜜夜游长沙短片", type: "video", isVideoSingle: true, productKind: "video_single", originalPrice: 359, price: 359, specialPrice: 359, isMainPush: false, mainPush: false, isShow: true, status: "上架", durationText: "60秒", previewVideoUrl: "", videoUrl: "", tags: ["闺蜜", "夜游"], intro: "闺蜜夜游长沙烟火气。", cover: LXM_SVG("短视频", "闺蜜夜游") }
  ],
  addonServices: [
    {
      id: "svc1",
      name: "加购精修3张",
      category: "修图",
      price: 199,
      enabled: true,
      intro: "通用加购服务。"
    },
    {
      id: "svc2",
      name: "加购照片5张",
      category: "加片",
      price: 259,
      enabled: true,
      intro: "增加交付照片数量。"
    },
    {
      id: "svc3",
      name: "改期保障",
      category: "改期",
      price: 99,
      enabled: true,
      intro: "拍摄前一次改期保障。"
    },
    {
      id: "svc4",
      spotId: "spot1",
      seriesId: "ser1",
      albumId: "alb1",
      name: "花园短视频加购",
      category: "短视频",
      price: 299,
      enabled: true,
      intro: "在拍照基础上增加短视频片段。"
    },
    {
      id: "svc5",
      spotId: "spot2",
      seriesId: "ser3",
      albumId: "alb3",
      name: "街区照片单品解锁",
      category: "照片单品",
      price: 159,
      enabled: true,
      intro: "解锁同系列样片参考照片单品。"
    }
  ],
  peripherals: [
    {
      id: "per1",
      name: "相册精装本",
      category: "相册",
      price: 129,
      enabled: true,
      isShow: true,
      intro: "线下交付可选周边。",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E7%9B%B8%E5%86%8C%E7%B2%BE%E8%A3%85%E6%9C%AC%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%91%84%E5%BD%B1%E5%91%A8%E8%BE%B9%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "per2",
      name: "明信片套装",
      category: "照片打印",
      price: 59,
      enabled: true,
      isShow: true,
      intro: "适合游客纪念。",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%98%8E%E4%BF%A1%E7%89%87%E5%A5%97%E8%A3%85%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%91%84%E5%BD%B1%E5%91%A8%E8%BE%B9%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "per3",
      name: "摆台相框",
      category: "相框装裱",
      price: 89,
      enabled: true,
      isShow: true,
      intro: "家庭摆台照片框。",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%91%86%E5%8F%B0%E7%9B%B8%E6%A1%86%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%91%84%E5%BD%B1%E5%91%A8%E8%BE%B9%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "per4",
      name: "创意DIY套装",
      category: "创意DIY",
      price: 139,
      enabled: true,
      isShow: true,
      intro: "照片周边创意套装。",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%88%9B%E6%84%8FDIY%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%91%84%E5%BD%B1%E5%91%A8%E8%BE%B9%3C%2Ftext%3E%3C%2Fsvg%3E"
    }
  ],
  guides: [
    {
      id: "guide1",
      name: "长沙旅拍避坑攻略",
      title: "长沙旅拍避坑攻略",
      status: "发布",
      tag: "新手",
      spotId: "spot1",
      seriesId: "ser1",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E6%97%85%E6%8B%8D%E6%94%BB%E7%95%A5%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%86%85%E5%AE%B9%E8%BF%90%E8%90%A5%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "guide2",
      name: "雨天拍摄备选路线",
      title: "雨天拍摄备选路线",
      status: "草稿",
      tag: "路线",
      spotId: "spot2",
      seriesId: "ser3",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E9%9B%A8%E5%A4%A9%E8%B7%AF%E7%BA%BF%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%86%85%E5%AE%B9%E8%BF%90%E8%90%A5%3C%2Ftext%3E%3C%2Fsvg%3E"
    }
  ],
  stories: [
    {
      id: "story1",
      name: "她们在长沙的黄昏",
      title: "她们在长沙的黄昏",
      subtitle: "城市与人的故事",
      status: "发布",
      tag: "客片故事",
      spotId: "spot1",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E9%95%BF%E6%B2%99%E6%95%85%E4%BA%8B%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%93%81%E7%89%8C%E6%95%85%E4%BA%8B%3C%2Ftext%3E%3C%2Fsvg%3E"
    },
    {
      id: "story2",
      name: "一个人的城市旅行",
      title: "一个人的城市旅行",
      subtitle: "定格每一刻心动",
      status: "发布",
      tag: "旅拍故事",
      spotId: "spot2",
      cover: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22720%22%20height%3D%22480%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20x2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23FF6B6B%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238B5E3C%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22720%22%20height%3D%22480%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%22615%22%20cy%3D%2288%22%20r%3D%2282%22%20fill%3D%22rgba(255%2C255%2C255%2C.15)%22%2F%3E%3Ctext%20x%3D%2246%22%20y%3D%22220%22%20font-size%3D%2244%22%20fill%3D%22white%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%9F%8E%E5%B8%82%E6%97%85%E8%A1%8C%3C%2Ftext%3E%3Ctext%20x%3D%2248%22%20y%3D%22278%22%20font-size%3D%2223%22%20fill%3D%22white%22%20opacity%3D%22.9%22%20font-family%3D%22Microsoft%20YaHei%2CArial%22%3E%E5%93%81%E7%89%8C%E6%95%85%E4%BA%8B%3C%2Ftext%3E%3C%2Fsvg%3E"
    }
  ],
  scans: [
    {
      id: "scan1",
      date: "2026-06-10",
      hour: 0,
      shopId: "shop1",
      scene: "门店台卡",
      openid: "openid0",
      orderId: "ord1"
    },
    {
      id: "scan2",
      date: "2026-06-11",
      hour: 1,
      shopId: "shop2",
      scene: "桌贴二维码",
      openid: "openid1",
      orderId: ""
    },
    {
      id: "scan3",
      date: "2026-06-12",
      hour: 2,
      shopId: "shop3",
      scene: "海报二维码",
      openid: "openid2",
      orderId: ""
    },
    {
      id: "scan6",
      date: "2026-06-15",
      hour: 5,
      shopId: "shop1",
      scene: "桌贴二维码",
      openid: "openid5",
      orderId: ""
    },
    {
      id: "scan7",
      date: "2026-06-16",
      hour: 6,
      shopId: "shop2",
      scene: "海报二维码",
      openid: "openid6",
      orderId: ""
    },
    {
      id: "scan8",
      date: "2026-06-17",
      hour: 7,
      shopId: "shop3",
      scene: "菜单二维码",
      openid: "openid7",
      orderId: ""
    },
    {
      id: "scan11",
      date: "2026-06-20",
      hour: 10,
      shopId: "shop1",
      scene: "海报二维码",
      openid: "openid10",
      orderId: ""
    },
    {
      id: "scan12",
      date: "2026-06-21",
      hour: 11,
      shopId: "shop2",
      scene: "菜单二维码",
      openid: "openid11",
      orderId: ""
    },
    {
      id: "scan13",
      date: "2026-06-22",
      hour: 12,
      shopId: "shop3",
      scene: "门店台卡",
      openid: "openid12",
      orderId: "ord13"
    },
    {
      id: "scan16",
      date: "2026-06-25",
      hour: 15,
      shopId: "shop1",
      scene: "菜单二维码",
      openid: "openid15",
      orderId: ""
    },
    {
      id: "scan17",
      date: "2026-06-10",
      hour: 16,
      shopId: "shop2",
      scene: "门店台卡",
      openid: "openid16",
      orderId: "ord3"
    },
    {
      id: "scan18",
      date: "2026-06-11",
      hour: 17,
      shopId: "shop3",
      scene: "桌贴二维码",
      openid: "openid17",
      orderId: ""
    },
    {
      id: "scan21",
      date: "2026-06-14",
      hour: 20,
      shopId: "shop1",
      scene: "门店台卡",
      openid: "openid20",
      orderId: "ord7"
    },
    {
      id: "scan22",
      date: "2026-06-15",
      hour: 21,
      shopId: "shop2",
      scene: "桌贴二维码",
      openid: "openid21",
      orderId: ""
    },
    {
      id: "scan23",
      date: "2026-06-16",
      hour: 22,
      shopId: "shop3",
      scene: "海报二维码",
      openid: "openid22",
      orderId: ""
    },
    {
      id: "scan26",
      date: "2026-06-19",
      hour: 1,
      shopId: "shop1",
      scene: "桌贴二维码",
      openid: "openid25",
      orderId: ""
    },
    {
      id: "scan27",
      date: "2026-06-20",
      hour: 2,
      shopId: "shop2",
      scene: "海报二维码",
      openid: "openid26",
      orderId: ""
    },
    {
      id: "scan28",
      date: "2026-06-21",
      hour: 3,
      shopId: "shop3",
      scene: "菜单二维码",
      openid: "openid27",
      orderId: ""
    },
    {
      id: "scan31",
      date: "2026-06-24",
      hour: 6,
      shopId: "shop1",
      scene: "海报二维码",
      openid: "openid30",
      orderId: ""
    },
    {
      id: "scan32",
      date: "2026-06-25",
      hour: 7,
      shopId: "shop2",
      scene: "菜单二维码",
      openid: "openid31",
      orderId: ""
    },
    {
      id: "scan33",
      date: "2026-06-10",
      hour: 8,
      shopId: "shop3",
      scene: "门店台卡",
      openid: "openid32",
      orderId: "ord5"
    },
    {
      id: "scan36",
      date: "2026-06-13",
      hour: 11,
      shopId: "shop1",
      scene: "菜单二维码",
      openid: "openid35",
      orderId: ""
    },
    {
      id: "scan37",
      date: "2026-06-14",
      hour: 12,
      shopId: "shop2",
      scene: "门店台卡",
      openid: "openid36",
      orderId: "ord9"
    },
    {
      id: "scan38",
      date: "2026-06-15",
      hour: 13,
      shopId: "shop3",
      scene: "桌贴二维码",
      openid: "openid0",
      orderId: ""
    },
    {
      id: "scan41",
      date: "2026-06-18",
      hour: 16,
      shopId: "shop1",
      scene: "门店台卡",
      openid: "openid3",
      orderId: "ord13"
    },
    {
      id: "scan42",
      date: "2026-06-19",
      hour: 17,
      shopId: "shop2",
      scene: "桌贴二维码",
      openid: "openid4",
      orderId: ""
    },
    {
      id: "scan43",
      date: "2026-06-20",
      hour: 18,
      shopId: "shop3",
      scene: "海报二维码",
      openid: "openid5",
      orderId: ""
    },
    {
      id: "scan46",
      date: "2026-06-23",
      hour: 21,
      shopId: "shop1",
      scene: "桌贴二维码",
      openid: "openid8",
      orderId: ""
    },
    {
      id: "scan47",
      date: "2026-06-24",
      hour: 22,
      shopId: "shop2",
      scene: "海报二维码",
      openid: "openid9",
      orderId: ""
    },
    {
      id: "scan48",
      date: "2026-06-25",
      hour: 23,
      shopId: "shop3",
      scene: "菜单二维码",
      openid: "openid10",
      orderId: ""
    },
    {
      id: "scan51",
      date: "2026-06-12",
      hour: 2,
      shopId: "shop1",
      scene: "海报二维码",
      openid: "openid13",
      orderId: ""
    },
    {
      id: "scan52",
      date: "2026-06-13",
      hour: 3,
      shopId: "shop2",
      scene: "菜单二维码",
      openid: "openid14",
      orderId: ""
    },
    {
      id: "scan53",
      date: "2026-06-14",
      hour: 4,
      shopId: "shop3",
      scene: "门店台卡",
      openid: "openid15",
      orderId: "ord11"
    },
    {
      id: "scan56",
      date: "2026-06-17",
      hour: 7,
      shopId: "shop1",
      scene: "菜单二维码",
      openid: "openid18",
      orderId: ""
    },
    {
      id: "scan57",
      date: "2026-06-18",
      hour: 8,
      shopId: "shop2",
      scene: "门店台卡",
      openid: "openid19",
      orderId: "ord1"
    },
    {
      id: "scan58",
      date: "2026-06-19",
      hour: 9,
      shopId: "shop3",
      scene: "桌贴二维码",
      openid: "openid20",
      orderId: ""
    },
    {
      id: "scan61",
      date: "2026-06-22",
      hour: 12,
      shopId: "shop1",
      scene: "门店台卡",
      openid: "openid23",
      orderId: "ord5"
    },
    {
      id: "scan62",
      date: "2026-06-23",
      hour: 13,
      shopId: "shop2",
      scene: "桌贴二维码",
      openid: "openid24",
      orderId: ""
    },
    {
      id: "scan63",
      date: "2026-06-24",
      hour: 14,
      shopId: "shop3",
      scene: "海报二维码",
      openid: "openid25",
      orderId: ""
    },
    {
      id: "scan_hq1",
      date: "2026-06-25",
      hour: 15,
      shopId: "",
      distributorId: "",
      sourceType: "headquarter",
      sourceName: "总部自有二维码",
      scene: "总部铺码",
      openid: "openid_hq1",
      orderId: "ord_hq1"
    }
  ],
  orders: [
    {
      id: "ord_hq1",
      orderNo: "LS202606199",
      openid: "openid_hq1",
      customer: "总部客源客人",
      phone: "13800001999",
      wechat: "wx_lxm_hq",
      shopId: "",
      distributorId: "",
      sourceType: "headquarter",
      sourceName: "总部自有二维码",
      sourceScene: "总部铺码",
      status: "completed",
      customerStatus: "done",
      assigneeId: "st2",
      photographerId: "st4",
      appointmentAt: "2026-06-25 15:00-16:00",
      completedAt: "2026-06-26 18:30",
      settlementObservationReleased: true,
      timePeriod: "下午",
      totalAmount: 1000,
      depositPaid: 300,
      finalPaid: 700,
      depositFinanceStatus: "已审核",
      finalFinanceStatus: "已审核",
      paymentVerify: "已核销",
      packageSnapshot: {},
      priceAdjustReason: "",
      customerRemark: "总部自有二维码扫码预约。",
      internalNote: "总部铺码获客，不产生商家或分销员分成。",
      products: [
        {
          id: "pkg1",
          type: "package",
          price: 1000
        }
      ],
      addons: [],
      statusLogs: [
        {
          time: "2026-06-25 15:10",
          operator: "客服小林",
          action: "总部自有二维码客源创建订单"
        },
        {
          time: "2026-06-26 18:30",
          operator: "客服小林",
          action: "订单已完成，收款已由财务审核"
        }
      ],
      deleted: false
    },
    {
      id: "ord1",
      orderNo: "LS202606101",
      openid: "openid0",
      customer: "周女士",
      phone: "13800001000",
      wechat: "wx_lxm_1",
      shopId: "shop1",
      distributorId: "",
      status: "cancelled",
      customerStatus: "reserved",
      assigneeId: "st3",
      photographerId: "",
      appointmentAt: "2026-06-12 08:00-09:00",
      timePeriod: "上午",
      totalAmount: 1000,
      depositPaid: 1000,
      finalPaid: 0,
      depositFinanceStatus: "已审核",
      depositPaidAt: "2026-06-24 12:20",
      paymentVerify: "未核销",
      packageSnapshot: {},
      priceAdjustReason: "客服沟通后优惠或加购调整",
      customerRemark: "客人预约备注：希望自然一点，可接受客服微信确认时间。",
      internalNote: "内部备注：微信沟通记录、分账和派单信息仅后台可见。",
      products: [
        {
          id: "pkg1",
          type: "package",
          price: 898
        }
      ],
      addons: [],
      statusLogs: [
        {
          time: "2026-06-26 10:00",
          operator: "客服小林",
          action: "客服创建订单"
        },
        {
          time: "2026-06-26 10:30",
          operator: "客服小林",
          action: "定金已收。"
        },
        {
          time: "2026-06-26 11:00",
          operator: "客服阿宁",
          action: "微信确认拍摄日期、地点和服装需求。"
        }
      ],
      deleted: false
    },
    {
      id: "ord2",
      orderNo: "LS202606102",
      openid: "openid1",
      customer: "陈先生",
      phone: "13800001001",
      wechat: "wx_lxm_2",
      shopId: "shop2",
      distributorId: "",
      status: "confirmed",
      customerStatus: "confirmed",
      assigneeId: "st2",
      photographerId: "",
      appointmentAt: "2026-06-13 09:00-10:00",
      timePeriod: "下午",
      totalAmount: 899,
      depositPaid: 200,
      finalPaid: 0,
      paymentVerify: "定金已核销",
      packageSnapshot: {},
      priceAdjustReason: "",
      customerRemark: "客人预约备注：希望自然一点，可接受客服微信确认时间。",
      internalNote: "内部备注：微信沟通记录、分账和派单信息仅后台可见。",
      products: [
        {
          id: "pkg2",
          type: "package",
          price: 899
        }
      ],
      addons: [],
      statusLogs: [
        {
          time: "2026-06-26 10:00",
          operator: "客服小林",
          action: "客服创建订单"
        },
        {
          time: "2026-06-26 10:30",
          operator: "客服小林",
          action: "定金已收。"
        },
        {
          time: "2026-06-26 11:00",
          operator: "客服阿宁",
          action: "微信确认拍摄日期、地点和服装需求。"
        }
      ],
      deleted: false
    },
    {
      id: "ord3",
      orderNo: "LS202606103",
      openid: "openid2",
      customer: "李同学",
      phone: "13800001002",
      wechat: "wx_lxm_3",
      shopId: "shop3",
      distributorId: "",
      status: "shooting",
      customerStatus: "shooting",
      assigneeId: "st3",
      photographerId: "st5",
      appointmentAt: "2026-06-14 10:00-11:00",
      timePeriod: "上午",
      totalAmount: 1199,
      depositPaid: 200,
      finalPaid: 0,
      paymentVerify: "定金已核销",
      packageSnapshot: {},
      priceAdjustReason: "",
      customerRemark: "客人预约备注：希望自然一点，可接受客服微信确认时间。",
      internalNote: "内部备注：微信沟通记录、分账和派单信息仅后台可见。",
      products: [
        {
          id: "pkg3",
          type: "package",
          price: 1199
        }
      ],
      addons: [],
      statusLogs: [
        {
          time: "2026-06-26 10:00",
          operator: "客服小林",
          action: "客服创建订单"
        },
        {
          time: "2026-06-26 10:30",
          operator: "客服小林",
          action: "定金已收。"
        },
        {
          time: "2026-06-26 11:00",
          operator: "客服阿宁",
          action: "微信确认拍摄日期、地点和服装需求。"
        }
      ],
      deleted: false
    },
    {
      id: "ord6",
      orderNo: "LS202606106",
      openid: "openid5",
      customer: "陈先生",
      phone: "13800001005",
      wechat: "wx_lxm_6",
      shopId: "shop1",
      distributorId: "",
      status: "confirmed",
      customerStatus: "confirmed",
      assigneeId: "st2",
      photographerId: "st4",
      appointmentAt: "2026-06-17 13:00-14:00",
      timePeriod: "下午",
      totalAmount: 699,
      depositPaid: 200,
      finalPaid: 0,
      paymentVerify: "定金已核销",
      packageSnapshot: {},
      priceAdjustReason: "",
      customerRemark: "客人预约备注：希望自然一点，可接受客服微信确认时间。",
      internalNote: "内部备注：微信沟通记录、分账和派单信息仅后台可见。",
      products: [
        {
          id: "pkg1",
          type: "package",
          price: 699
        }
      ],
      addons: [],
      statusLogs: [
        {
          time: "2026-06-26 10:00",
          operator: "客服小林",
          action: "客服创建订单"
        },
        {
          time: "2026-06-26 10:30",
          operator: "客服小林",
          action: "定金已收。"
        },
        {
          time: "2026-06-26 11:00",
          operator: "客服阿宁",
          action: "微信确认拍摄日期、地点和服装需求。"
        }
      ],
      deleted: false
    },
    {
      id: "ord7",
      orderNo: "LS202606107",
      openid: "openid6",
      customer: "李同学",
      phone: "13800001006",
      wechat: "wx_lxm_7",
      shopId: "shop2",
      distributorId: "",
      status: "shooting",
      customerStatus: "shooting",
      assigneeId: "st3",
      photographerId: "st5",
      appointmentAt: "2026-06-18 14:00-15:00",
      timePeriod: "上午",
      totalAmount: 1098,
      depositPaid: 200,
      finalPaid: 0,
      paymentVerify: "定金已核销",
      packageSnapshot: {},
      priceAdjustReason: "客服沟通后优惠或加购调整",
      customerRemark: "客人预约备注：希望自然一点，可接受客服微信确认时间。",
      internalNote: "内部备注：微信沟通记录、分账和派单信息仅后台可见。",
      products: [
        {
          id: "pkg2",
          type: "package",
          price: 1098
        }
      ],
      addons: [],
      statusLogs: [
        {
          time: "2026-06-26 10:00",
          operator: "客服小林",
          action: "客服创建订单"
        },
        {
          time: "2026-06-26 10:30",
          operator: "客服小林",
          action: "定金已收。"
        },
        {
          time: "2026-06-26 11:00",
          operator: "客服阿宁",
          action: "微信确认拍摄日期、地点和服装需求。"
        }
      ],
      deleted: false
    },
    {
      id: "ord8",
      orderNo: "LS202606108",
      openid: "openid7",
      customer: "赵小姐",
      phone: "13800001007",
      wechat: "wx_lxm_8",
      shopId: "shop3",
      distributorId: "",
      status: "completed",
      customerStatus: "done",
      assigneeId: "st2",
      photographerId: "st4",
      appointmentAt: "2026-06-19 15:00-16:00",
      timePeriod: "下午",
      totalAmount: 1199,
      depositPaid: 200,
      finalPaid: 999,
      depositFinanceStatus: "已审核",
      finalFinanceStatus: "已审核",
      completedAt: "2026-07-01 18:30",
      paymentVerify: "定金已核销",
      packageSnapshot: {},
      priceAdjustReason: "",
      customerRemark: "客人预约备注：希望自然一点，可接受客服微信确认时间。",
      internalNote: "内部备注：微信沟通记录、分账和派单信息仅后台可见。",
      products: [
        {
          id: "pkg3",
          type: "package",
          price: 1199
        }
      ],
      addons: [],
      statusLogs: [
        {
          time: "2026-06-26 10:00",
          operator: "客服小林",
          action: "客服创建订单"
        },
        {
          time: "2026-06-26 10:30",
          operator: "客服小林",
          action: "定金已收。"
        },
        {
          time: "2026-06-26 11:00",
          operator: "客服阿宁",
          action: "微信确认拍摄日期、地点和服装需求。"
        }
      ],
      deleted: false
    },
    {
      id: "ord11",
      orderNo: "LS202606111",
      openid: "openid10",
      customer: "李同学",
      phone: "13800001010",
      wechat: "wx_lxm_11",
      shopId: "shop1",
      distributorId: "",
      status: "shooting",
      customerStatus: "shooting",
      assigneeId: "st3",
      photographerId: "st5",
      appointmentAt: "2026-06-22 10:00-11:00",
      timePeriod: "上午",
      totalAmount: 699,
      depositPaid: 200,
      finalPaid: 0,
      paymentVerify: "定金已核销",
      packageSnapshot: {},
      priceAdjustReason: "",
      customerRemark: "客人预约备注：希望自然一点，可接受客服微信确认时间。",
      internalNote: "内部备注：微信沟通记录、分账和派单信息仅后台可见。",
      products: [
        {
          id: "pkg1",
          type: "package",
          price: 699
        }
      ],
      addons: [],
      statusLogs: [
        {
          time: "2026-06-26 10:00",
          operator: "客服小林",
          action: "客服创建订单"
        },
        {
          time: "2026-06-26 10:30",
          operator: "客服小林",
          action: "定金已收。"
        },
        {
          time: "2026-06-26 11:00",
          operator: "客服阿宁",
          action: "微信确认拍摄日期、地点和服装需求。"
        }
      ],
      deleted: false
    },
    {
      id: "ord12",
      orderNo: "LS202606112",
      openid: "openid11",
      customer: "赵小姐",
      phone: "13800001011",
      wechat: "wx_lxm_12",
      shopId: "shop2",
      distributorId: "",
      status: "completed",
      customerStatus: "done",
      assigneeId: "st2",
      photographerId: "st4",
      appointmentAt: "2026-06-23 11:00-12:00",
      timePeriod: "下午",
      totalAmount: 899,
      depositPaid: 200,
      finalPaid: 699,
      paymentVerify: "定金已核销",
      packageSnapshot: {},
      priceAdjustReason: "",
      customerRemark: "客人预约备注：希望自然一点，可接受客服微信确认时间。",
      internalNote: "内部备注：微信沟通记录、分账和派单信息仅后台可见。",
      products: [
        {
          id: "pkg2",
          type: "package",
          price: 899
        }
      ],
      addons: [],
      statusLogs: [
        {
          time: "2026-06-26 10:00",
          operator: "客服小林",
          action: "客服创建订单"
        },
        {
          time: "2026-06-26 10:30",
          operator: "客服小林",
          action: "定金已收。"
        },
        {
          time: "2026-06-26 11:00",
          operator: "客服阿宁",
          action: "微信确认拍摄日期、地点和服装需求。"
        }
      ],
      deleted: false
    },
    {
      id: "ord13",
      orderNo: "LS202606113",
      openid: "openid12",
      customer: "周女士",
      phone: "13800001012",
      wechat: "wx_lxm_13",
      shopId: "shop3",
      distributorId: "",
      status: "pending",
      customerStatus: "reserved",
      assigneeId: "st3",
      photographerId: "st5",
      appointmentAt: "2026-06-24 12:00-13:00",
      timePeriod: "上午",
      totalAmount: 1398,
      depositPaid: 0,
      finalPaid: 0,
      paymentVerify: "未核销",
      packageSnapshot: {},
      priceAdjustReason: "客服沟通后优惠或加购调整",
      customerRemark: "客人预约备注：希望自然一点，可接受客服微信确认时间。",
      internalNote: "内部备注：微信沟通记录、分账和派单信息仅后台可见。",
      products: [
        {
          id: "pkg3",
          type: "package",
          price: 1398
        }
      ],
      addons: [],
      statusLogs: [
        {
          time: "2026-06-26 10:00",
          operator: "客服小林",
          action: "客服创建订单"
        },
        {
          time: "2026-06-26 10:30",
          operator: "客服小林",
          action: "定金已收。"
        },
        {
          time: "2026-06-26 11:00",
          operator: "客服阿宁",
          action: "微信确认拍摄日期、地点和服装需求。"
        }
      ],
      deleted: false
    }
  ],
  afterSales: [
    {
      id: "as1",
      orderId: "ord2",
      type: "改期",
      customer: "陈先生",
      reason: "客人行程变更，申请改到下周下午。",
      status: "待处理",
      customerVisibleStatus: "已提交",
      submitSource: "小程序提交",
      assigneeId: "st2",
      createdAt: "2026-06-27 14:20",
      logs: [
        "客人小程序提交售后：申请改期"
      ]
    },
    {
      id: "as2",
      orderId: "ord4",
      type: "退款咨询",
      customer: "赵小姐",
      reason: "客人临时取消，咨询定金是否可退。",
      status: "处理中",
      customerVisibleStatus: "处理中",
      submitSource: "后台提交",
      assigneeId: "st3",
      createdAt: "2026-06-27 18:10",
      logs: [
        "客服阿宁说明退款规则，等待客人确认"
      ]
    },
    {
      id: "as3",
      orderId: "ord6",
      type: "补发成片",
      customer: "陈先生",
      reason: "客人微信文件过期，需要重新发送成片。",
      status: "已完成",
      customerVisibleStatus: "已完成",
      submitSource: "后台提交",
      assigneeId: "st2",
      createdAt: "2026-06-28 11:05",
      logs: [
        "客服小林已重新微信发送"
      ]
    },
    {
      id: "as4",
      orderId: "ord8",
      type: "投诉反馈",
      customer: "赵小姐",
      reason: "客人反馈沟通等待时间较长，需要回访。",
      status: "待处理",
      customerVisibleStatus: "已提交",
      submitSource: "小程序提交",
      assigneeId: "st3",
      createdAt: "2026-06-28 16:40",
      logs: [
        "客人小程序提交售后：投诉反馈"
      ]
    }
  ],
  financeSettings: {
    settlementObservationDays: 3
  },
  monthlyClosings: [
    {
      month: "2026-05",
      status: "已关账",
      operator: "鹿小鸣主理人",
      time: "2026-06-03 18:20",
      note: "五月月度分账已完成，数据锁定"
    }
  ],
  adjustmentRecords: [
    {
      id: "adj1",
      orderNo: "LS202606101",
      orderId: "ord1",
      time: "2026-06-30 17:20",
      type: "人工调账",
      amount: -100,
      targetType: "商家",
      targetName: "复古书屋",
      operator: "财务小鹿",
      approvalStatus: "待审批",
      note: "演示：结算后售后差额冲正，待超管审批",
      attachment: "transfer-adjust-demo.pdf"
    }
  ],
  logs: [
    {
      time: "2026-06-26 10:00",
      user: "客服小林",
      action: "订单操作",
      target: "LS202606101",
      detail: "客服创建订单"
    },
    {
      time: "2026-06-26 10:30",
      user: "客服小林",
      action: "订单操作",
      target: "LS202606101",
      detail: "定金已收。"
    },
    {
      time: "2026-06-29 00:30",
      user: "系统",
      action: "业务模型升级",
      target: "后台",
      detail: "加入分销员、商家溯源与统一角色权限。"
    }
  ],
  trash: [],
  homeConfig: {
    activity: "记录城市与你的故事",
    cityName: "长沙",
    shopServiceText: "合作旅拍服务",
    heroSubtitle: "游客扫码后直接进入长沙旅拍预约页",
    trustOrders: 218,
    trustRate: "96%",
    modules: [
      "主推套餐",
      "热门打卡点",
      "照片单品",
      "摄影周边",
      "攻略故事"
    ],
    enabledModules: [
      "mainPush",
      "spots",
      "albums",
      "peripherals",
      "guides"
    ],
    carouselIds: [
      "sample1",
      "sample2",
      "sample3",
      "sample4"
    ],
    featuredPackageIds: [
      "pkg1",
      "pkg3"
    ],
    featuredAlbumIds: [
      "alb1",
      "alb2"
    ],
    featuredPeripheralIds: [
      "per1",
      "per2"
    ],
    notice: "暑期长沙旅拍预约开放中，客服会在30分钟内联系确认。",
    // 探索页轮播：与首页轮播「单独一套」，后台在 mini-decor 独立配置（默认空，游客端走小程序兜底文案）
    exploreBanners: [],
    // 首页 Banner（高级图文轮播）：与「样片快速选」「探索页轮播」均独立，支持封面/视频+标题+跳转+生效时间
    homeBanners: [],
    // 首页快捷入口（可后台配置的"导航"）：tabBar 不可运行时改，故用首页快捷入口承载
    quickNav: [
      { targetType: "all_spots", label: "全部打卡点", icon: "📍" },
      { targetType: "package_list", label: "全部套餐", icon: "📷" },
      { targetType: "videos", label: "城市短视频", icon: "🎬" },
      { targetType: "peripherals", label: "旅拍周边", icon: "🎁" },
      { targetType: "my", label: "我的订单", icon: "👤" }
    ],
    pageModules: {
      spotDetail: {
        title: "打卡点详情页",
        enabledModules: ["banner", "serviceIntro", "guide", "relatedPackages"],
        bannerIds: ["sample1", "sample2", "sample3"],
        packageIds: ["pkg1", "pkg3"],
        albumIds: ["alb1", "alb2"],
        videoIds: ["pkg3"],
        guideIds: ["guide1"],
        peripheralIds: ["per1"]
      },
      seriesDetail: {
        title: "系列详情页",
        enabledModules: ["banner", "mainPackage", "albums", "recommendPackages"],
        bannerIds: ["sample1", "sample6"],
        packageIds: ["pkg1", "pkg3"],
        albumIds: ["alb1", "alb2"],
        videoIds: ["pkg3"],
        guideIds: [],
        peripheralIds: []
      },
      albumDetail: {
        title: "照片单品详情页",
        enabledModules: ["banner", "samples", "shootingNote", "recommendContent"],
        bannerIds: ["sample1", "sample6", "sample11"],
        packageIds: ["pkg1"],
        albumIds: ["alb1"],
        videoIds: [],
        guideIds: ["guide1"],
        peripheralIds: ["per1"]
      },
      videoDetail: {
        title: "短视频详情页",
        enabledModules: ["video", "shootingNote", "recommendVideos", "recommendContent"],
        bannerIds: ["sample3", "sample8"],
        packageIds: ["pkg3"],
        albumIds: [],
        videoIds: ["pkg3"],
        guideIds: ["guide1"],
        peripheralIds: []
      },
      packageDetail: {
        title: "套餐详情页",
        enabledModules: ["banner", "includedAlbums", "includedVideos", "bookingRule", "recommendContent"],
        bannerIds: ["sample1", "sample2"],
        packageIds: ["pkg1", "pkg3"],
        albumIds: ["alb1", "alb2"],
        videoIds: ["pkg3"],
        guideIds: ["guide1"],
        peripheralIds: ["per1"]
      }
    }
  },
  // 小程序全局配置：小程序游客端原写死的通用文案/规则，现统一后台可配（§七 缺口补全）
  siteConfig: {
    // 约拍定制：计价规则可后台配（小程序 bookingInfo 原硬编码）
    customPrice: {
      baseHours: 1,
      singlePersonPrice: 200,
      perExtraPerson: 100,
      note: "每增加 1 人拍摄 +¥100，时长默认 1 小时"
    },
    // 预约须知：小程序预约页底部展示
    bookingNotice: [
      "需提前 1 天预约，方便摄影师排期",
      "拍摄时长约 1 小时，底片全送",
      "雨天可免费改期",
      "成片周期 7 个工作日，企业微信交付"
    ],
    // 隐私政策正文（小程序「隐私政策」页展示，替换原硬编码文案）
    privacyText: "鹿小鸣旅拍（以下简称“我们”）非常重视你的个人信息和隐私保护。在你使用小程序预约旅拍服务时，我们仅收集完成预约所必需的姓名、手机号与拍摄偏好，用于安排摄影团队与交付成片。我们不会向无关第三方分享你的个人信息，详情可在小程序内查阅完整隐私政策。（运营可在后台编辑完整条款）",
    // 企业微信：小程序「我的」页一键跳转客服使用（corpId 原读 globalData.corpId）
    wechat: {
      corpId: "",
      appId: "wx11ac41ab0c57e22f",
      guideText: "点击前往企业微信，专属顾问 1 对 1 为你服务"
    },
    // 搜索：热词（小程序搜索首页与探索页展示，原硬编码 demoData）
    search: {
      hotwords: ["橘子洲", "五一广场", "岳麓山", "古风写真", "情侣旅拍", "暑期套餐"]
    },
    // 足迹章册（小程序「我的」页，原读 siteConfig.getPageModuleConfig('my').footprint）
    footprint: {
      enabled: true,
      total: 12,
      title: "长沙旅拍足迹",
      rewardText: "集满 8 枚印章，送精修电子相册 1 份"
    }
  },
  merchantCodes: [
    {
      _id: "Qdemo01counter",
      shopId: "SHOP001",
      shopName: "鹿山咖啡",
      placementType: "counter",
      placementLabel: "吧台",
      scene: "c=Qdemo01counter",
      scanCount: 128,
      orderCount: 12,
      dealCount: 9,
      qrImage: "",
      status: "active",
      createTime: "2026-07-01T00:00:00.000Z"
    },
    {
      _id: "Qdemo01table",
      shopId: "SHOP001",
      shopName: "鹿山咖啡",
      placementType: "table",
      placementLabel: "桌子",
      scene: "c=Qdemo01table",
      scanCount: 86,
      orderCount: 7,
      dealCount: 5,
      qrImage: "",
      status: "active",
      createTime: "2026-07-02T00:00:00.000Z"
    }
  ]
};

window.LXM_DATA.orders.forEach((order) => {
  order.products = order.products.map((product) => {
    const source = window.LXM_DATA.packages.find((item) => item.id === product.id) || window.LXM_DATA.albums.find((item) => item.id === product.id);
    if (!source) return product;
    const snapshot = {
      id: source.id,
      name: source.name,
      originalPrice: source.originalPrice || source.price,
      price: source.price,
      serviceTags: source.serviceTags || [],
      isMainPush: !!source.isMainPush
    };
    order.packageSnapshot = snapshot;
    return {
      ...product,
      spotId: source.spotId,
      seriesId: source.seriesId,
      albumId: source.albumId,
      name: source.name,
      price: product.price || source.price,
      snapshot
    };
  });
});
